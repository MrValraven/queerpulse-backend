import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Message } from './entities/message.entity';
import {
  EVIDENCE_HOLD_SWEEP_BATCH_SIZE,
  EVIDENCE_HOLD_SWEEP_MAX_BATCHES_PER_RUN,
  MessageEvidenceHoldSweepService,
} from './message-evidence-hold-sweep.service';
import { MessagesService } from './messages.service';

/**
 * ENG-268: `MessageEvidenceHoldSweepService` had no spec at all before this.
 * It is the one process that unblanks a tombstone's body/attachment and hands
 * its bytes to `MessagesService.purgeReleasedAttachmentBytes` for deletion
 * (PRD-361), so the valuable coverage here proves it holds the line on how
 * much it purges, staying limited to exactly what the hold actually releases.
 *
 * Scoped the same way `message-search-scoping.spec.ts` scopes
 * `MessagesService`: the real `Message` repository is replaced by a
 * hand-built query-builder stand-in (both the SELECT chain `sweepReleasedHolds`
 * builds and the UPDATE chain `releaseRows` builds share the repository's
 * `createQueryBuilder`, so one stand-in serves both), and `MessagesService`
 * is a bare mock. This suite is about the sweep's OWN batching/release logic;
 * see `message-attachment-purge.spec.ts` for attachment purging itself.
 */
describe('MessageEvidenceHoldSweepService (ENG-268 / PRD-361)', () => {
  interface SweepQueryBuilder {
    withDeleted: jest.Mock;
    select: jest.Mock;
    where: jest.Mock;
    andWhere: jest.Mock;
    orderBy: jest.Mock;
    limit: jest.Mock;
    getMany: jest.Mock;
    update: jest.Mock;
    set: jest.Mock;
    returning: jest.Mock;
    execute: jest.Mock;
  }

  function makeQueryBuilder(): SweepQueryBuilder {
    const qb = {} as SweepQueryBuilder;
    const self = (): SweepQueryBuilder => qb;
    qb.withDeleted = jest.fn(self);
    qb.select = jest.fn(self);
    qb.where = jest.fn(self);
    qb.andWhere = jest.fn(self);
    qb.orderBy = jest.fn(self);
    qb.limit = jest.fn(self);
    qb.getMany = jest.fn();
    qb.update = jest.fn(self);
    qb.set = jest.fn(self);
    qb.returning = jest.fn(self);
    qb.execute = jest.fn();
    return qb;
  }

  /** A due row shaped exactly like `dueMessages`' `select(['message.id',
   *  'message.attachment'])` projection. */
  function dueRow(id: string, attachment: unknown = null) {
    return { id, attachment } as Message;
  }

  function findAndWhereCall(
    qb: SweepQueryBuilder,
    matcher: (sql: string) => boolean,
  ): [string, Record<string, unknown>] | undefined {
    const calls = qb.andWhere.mock.calls as [string, Record<string, unknown>][];
    return calls.find(([sql]) => matcher(sql));
  }

  let service: MessageEvidenceHoldSweepService;
  let qb: SweepQueryBuilder;
  let messages: { createQueryBuilder: jest.Mock };
  let messagesService: { purgeReleasedAttachmentBytes: jest.Mock };

  beforeEach(async () => {
    qb = makeQueryBuilder();
    messages = { createQueryBuilder: jest.fn(() => qb) };
    messagesService = { purgeReleasedAttachmentBytes: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MessageEvidenceHoldSweepService,
        { provide: getRepositoryToken(Message), useValue: messages },
        { provide: MessagesService, useValue: messagesService },
      ],
    }).compile();
    service = module.get(MessageEvidenceHoldSweepService);
  });

  const now = new Date('2026-09-16T12:00:00.000Z');
  const imageAttachment = {
    url: 'message-images/u1/photo.jpg',
    previewUrl: 'message-images/u1/photo.jpg',
    width: 10,
    height: 10,
    provider: 'upload',
  };

  describe('the SELECT predicate (which rows are even candidates)', () => {
    it('requires a non-null, already-passed attachmentPurgeAfter, inclusive of the exact expiry instant', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.sweepReleasedHolds(now);

      expect(qb.andWhere).toHaveBeenCalledWith(
        'message.attachmentPurgeAfter IS NOT NULL',
      );
      // `<=` (not `<`): a hold expiring at EXACTLY `now` is due this run, not
      // held over one more tick.
      const expiryCall = findAndWhereCall(qb, (sql) =>
        sql.includes('message.attachmentPurgeAfter <='),
      );
      expect(expiryCall).toBeDefined();
      expect(expiryCall![1]).toEqual({ now });
    });

    it('excludes any message an open or escalated report still names', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.sweepReleasedHolds(now);

      const reportCall = findAndWhereCall(qb, (sql) =>
        sql.includes('"reports" "holding_report"'),
      );
      expect(reportCall).toBeDefined();
      const [sql, params] = reportCall!;
      expect(sql).toContain(
        '"holding_report"."subject_id" = "message"."id"::text',
      );
      expect(sql).toContain(
        '"holding_report"."status" IN (:...holdingReportStatuses)',
      );
      expect(params).toEqual({
        heldSubjectType: ReportSubjectType.Message,
        holdingReportStatuses: [ReportStatus.Open, ReportStatus.Escalated],
      });
    });

    it('reads soft-deleted rows (withDeleted) and stops at the batch size', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.sweepReleasedHolds(now);

      expect(qb.withDeleted).toHaveBeenCalled();
      expect(qb.limit).toHaveBeenCalledWith(EVIDENCE_HOLD_SWEEP_BATCH_SIZE);
    });
  });

  describe('a hold that has expired is released and its bytes purged', () => {
    it('purges only the rows the UPDATE actually released, leaving every other due row alone', async () => {
      // Two rows are DUE by the SELECT's own predicate, but the atomic UPDATE
      // (which re-checks every predicate, including the report one) only
      // actually releases ONE of them, modelling a report filed between the
      // SELECT and the UPDATE. The row the UPDATE did NOT touch must never be
      // purged: its evidence hold effectively still holds.
      qb.getMany.mockResolvedValueOnce([
        dueRow('released-1', imageAttachment),
        dueRow('still-held-2', imageAttachment),
      ]);
      qb.execute.mockResolvedValueOnce({ raw: [{ id: 'released-1' }] });

      const releasedCount = await service.sweepReleasedHolds(now);

      expect(releasedCount).toBe(1);
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).toHaveBeenCalledTimes(1);
      expect(messagesService.purgeReleasedAttachmentBytes).toHaveBeenCalledWith(
        'released-1',
        imageAttachment,
      );
    });

    it('re-checks every predicate again in the UPDATE itself, including the report NOT EXISTS', async () => {
      qb.getMany.mockResolvedValueOnce([dueRow('m1', imageAttachment)]);
      qb.execute.mockResolvedValueOnce({ raw: [{ id: 'm1' }] });

      await service.sweepReleasedHolds(now);

      expect(qb.update).toHaveBeenCalledWith(Message);
      expect(qb.set).toHaveBeenCalledWith({
        body: '',
        attachment: null,
        attachmentPurgeAfter: null,
      });
      expect(qb.where).toHaveBeenCalledWith('id IN (:...messageIds)', {
        messageIds: ['m1'],
      });
      expect(qb.andWhere).toHaveBeenCalledWith('deleted_at IS NOT NULL');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'attachment_purge_after IS NOT NULL',
      );
      const expiryCall = findAndWhereCall(qb, (sql) =>
        sql.includes('attachment_purge_after <='),
      );
      expect(expiryCall).toBeDefined();
      // Matched on the plural `"messages"."id"` alias specifically: the
      // SELECT half of this same batch also called `andWhere` with a
      // `"reports" "holding_report"` fragment (singular `"message"."id"`),
      // so a looser substring match here would silently find that call
      // instead of the UPDATE's own.
      const updateReportCall = findAndWhereCall(qb, (sql) =>
        sql.includes('"holding_report"."subject_id" = "messages"."id"::text'),
      );
      expect(updateReportCall).toBeDefined();
      expect(updateReportCall![0]).toContain('"reports" "holding_report"');
      expect(updateReportCall![0]).toContain(
        '"holding_report"."status" IN (:...holdingReportStatuses)',
      );
    });

    it('skips the purge call for a released row that carried no attachment', async () => {
      // A plain text message can still carry an evidence hold (PRD-361 holds
      // the BODY too); releasing it should blank the row but never call
      // purgeReleasedAttachmentBytes with nothing to purge.
      qb.getMany.mockResolvedValueOnce([dueRow('text-only', null)]);
      qb.execute.mockResolvedValueOnce({ raw: [{ id: 'text-only' }] });

      const releasedCount = await service.sweepReleasedHolds(now);

      expect(releasedCount).toBe(1);
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).not.toHaveBeenCalled();
    });

    it('purges nothing when the UPDATE releases nothing at all', async () => {
      // Every candidate row lost its hold-release race (e.g. a report was
      // filed on all of them between SELECT and UPDATE).
      qb.getMany.mockResolvedValueOnce([dueRow('still-held', imageAttachment)]);
      qb.execute.mockResolvedValueOnce({ raw: [] });

      const releasedCount = await service.sweepReleasedHolds(now);

      expect(releasedCount).toBe(0);
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).not.toHaveBeenCalled();
    });
  });

  describe('batching', () => {
    it('stops after the first short page without querying again', async () => {
      const shortBatch = Array.from(
        { length: EVIDENCE_HOLD_SWEEP_BATCH_SIZE - 1 },
        (_, index) => dueRow(`m${index}`),
      );
      qb.getMany.mockResolvedValueOnce(shortBatch);
      qb.execute.mockResolvedValueOnce({
        raw: shortBatch.map((row) => ({ id: row.id })),
      });

      await service.sweepReleasedHolds(now);

      // One SELECT + one UPDATE only: a page shorter than the batch size means
      // there is nothing left, so a second SELECT would be wasted work.
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('keeps paging while a batch comes back full, up to the per-run cap', async () => {
      const fullBatch = Array.from(
        { length: EVIDENCE_HOLD_SWEEP_BATCH_SIZE },
        (_, index) => dueRow(`m${index}`),
      );
      // Every batch (SELECT) comes back completely full, and every UPDATE
      // releases the whole page, so this run should hit the batches-per-run
      // ceiling rather than looping forever against an enormous backlog.
      qb.getMany.mockResolvedValue(fullBatch);
      qb.execute.mockResolvedValue({
        raw: fullBatch.map((row) => ({ id: row.id })),
      });

      const releasedCount = await service.sweepReleasedHolds(now);

      expect(releasedCount).toBe(
        EVIDENCE_HOLD_SWEEP_BATCH_SIZE *
          EVIDENCE_HOLD_SWEEP_MAX_BATCHES_PER_RUN,
      );
      // One SELECT + one UPDATE per batch, capped at the documented ceiling.
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(
        EVIDENCE_HOLD_SWEEP_MAX_BATCHES_PER_RUN * 2,
      );
    });

    it('returns 0 and issues no UPDATE when nothing is due', async () => {
      qb.getMany.mockResolvedValueOnce([]);

      const releasedCount = await service.sweepReleasedHolds(now);

      expect(releasedCount).toBe(0);
      expect(qb.execute).not.toHaveBeenCalled();
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).not.toHaveBeenCalled();
    });
  });

  describe('idempotency: a second run purges nothing extra', () => {
    it('purges nothing on a re-run once every due row has already been released', async () => {
      qb.getMany.mockResolvedValueOnce([dueRow('m1', imageAttachment)]);
      qb.execute.mockResolvedValueOnce({ raw: [{ id: 'm1' }] });
      const firstRunReleased = await service.sweepReleasedHolds(now);
      expect(firstRunReleased).toBe(1);
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).toHaveBeenCalledTimes(1);

      // A released row's `attachmentPurgeAfter` is now NULL, so it no longer
      // matches the SELECT's `IS NOT NULL` predicate. Modelled here by the
      // next SELECT simply returning nothing.
      qb.getMany.mockResolvedValueOnce([]);
      const secondRunReleased = await service.sweepReleasedHolds(now);

      expect(secondRunReleased).toBe(0);
      expect(
        messagesService.purgeReleasedAttachmentBytes,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleHourlySweep (the @Cron entry point)', () => {
    it('does not run a second sweep while one is already in flight', async () => {
      let resolveFirstGetMany: (rows: Message[]) => void = () => {};
      qb.getMany.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirstGetMany = resolve;
          }),
      );

      const firstRun = service.handleHourlySweep();
      // The first run is still awaiting its SELECT; a second tick landing now
      // must skip rather than compete for the same rows.
      const secondRun = service.handleHourlySweep();

      resolveFirstGetMany([]);
      await Promise.all([firstRun, secondRun]);

      // Only the first call's SELECT ever ran.
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(1);
    });

    it('allows a fresh run once the previous one has finished', async () => {
      qb.getMany.mockResolvedValueOnce([]);
      await service.handleHourlySweep();
      qb.getMany.mockResolvedValueOnce([]);
      await service.handleHourlySweep();

      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    });

    it('logs and swallows a failure instead of throwing (matches every other @Cron sweeper)', async () => {
      qb.getMany.mockRejectedValueOnce(new Error('connection reset'));

      await expect(service.handleHourlySweep()).resolves.toBeUndefined();

      // The reentrancy guard must also clear itself back to false on failure.
      qb.getMany.mockResolvedValueOnce([]);
      await expect(service.handleHourlySweep()).resolves.toBeUndefined();
      expect(messages.createQueryBuilder).toHaveBeenCalledTimes(2);
    });
  });
});
