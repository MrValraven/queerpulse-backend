import { HttpException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { DataSource, EntityManager } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { StudioTakedownReportService } from '../moderation/studio-takedown-report.service';
import { Report } from '../reports/entities/report.entity';
import { TakedownStudioReleaseDto } from './dto/takedown-studio-release.dto';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioModerationService } from './studio-moderation.service';

const STAFF_ID = 'f1000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'f1000000-0000-4000-8000-000000000002';
const PUBLISHED_AT = new Date('2026-10-01T09:00:00.000Z');
const REPORT_ID = 'f1000000-0000-4000-8000-0000000000aa';
const OTHER_REPORT_ID = 'f1100000-0000-4000-8000-0000000000bb';
const resolvedReports = [
  { id: REPORT_ID, status: 'resolved' },
  { id: OTHER_REPORT_ID, status: 'resolved' },
] as Report[];

describe('StudioModerationService', () => {
  let release: StudioRelease | null;
  // The open dispute about the release; none unless a test says so.
  let openDispute: Pick<StudioReleaseDispute, 'id'> | null;
  let manager: { findOne: jest.Mock; save: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let catalog: { getReleaseForStaff: jest.Mock };
  let takedownReports: {
    resolveWithin: jest.Mock;
    notifyReportersBestEffort: jest.Mock;
  };
  let eventEmitter: { emit: jest.Mock };
  // Events emitted before the transaction resolved; post-commit means zero.
  let emitsInsideTransaction: number;
  let service: StudioModerationService;

  beforeEach(() => {
    release = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      publishedAt: PUBLISHED_AT,
      takenDownAt: null,
      takenDownById: null,
      takedownReason: null,
    } as StudioRelease;
    openDispute = null;
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioReleaseDispute ? openDispute : release,
        ),
      ),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    catalog = {
      getReleaseForStaff: jest.fn().mockResolvedValue({ id: RELEASE_ID }),
    };
    takedownReports = {
      // No open or escalated report about the release unless a test says so.
      resolveWithin: jest
        .fn()
        .mockResolvedValue({ kind: 'resolved', reports: [] }),
      notifyReportersBestEffort: jest.fn().mockResolvedValue(undefined),
    };
    eventEmitter = { emit: jest.fn() };
    emitsInsideTransaction = 0;
    const dataSource = {
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) => {
          const result = await work(manager as unknown as EntityManager);
          emitsInsideTransaction += eventEmitter.emit.mock.calls.length;
          return result;
        },
      ),
    };
    service = new StudioModerationService(
      dataSource as unknown as DataSource,
      catalog as unknown as StudioCatalogService,
      modAudit as unknown as ModAuditService,
      takedownReports as unknown as StudioTakedownReportService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  it('locks the release, then records the reason, the staff member and the time', async () => {
    const before = Date.now();
    await service.takedown(STAFF_ID, RELEASE_ID, 'Uploaded without the rights');
    expect(manager.findOne).toHaveBeenCalledWith(StudioRelease, {
      where: { id: RELEASE_ID },
      lock: { mode: 'pessimistic_write' },
    });
    const saved = manager.save.mock.calls[0]![0] as StudioRelease;
    expect(saved.status).toBe('taken_down');
    expect(saved.takenDownById).toBe(STAFF_ID);
    expect(saved.takedownReason).toBe('Uploaded without the rights');
    expect(saved.takenDownAt!.getTime()).toBeGreaterThanOrEqual(before);
    expect(saved.publishedAt).toBe(PUBLISHED_AT);
    expect(catalog.getReleaseForStaff).toHaveBeenCalledWith(RELEASE_ID);
  });

  it('audits the takedown in the same transaction without naming the owner', async () => {
    await service.takedown(STAFF_ID, RELEASE_ID, 'Uploaded without the rights');
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_release_taken_down',
      undefined,
      `${RELEASE_ID}: Uploaded without the rights`,
      undefined,
      manager,
      null,
    );
  });

  it('keeps the first takedown when asked twice', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      takedownReason: 'First',
    };
    await service.takedown(STAFF_ID, RELEASE_ID, 'Second');
    expect(manager.save).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
  });

  it('restores a release that was live back to published and clears the takedown', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      takedownReason: 'First',
      takenDownById: STAFF_ID,
      takenDownAt: new Date(),
    };
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({
        status: 'published',
        takedownReason: null,
        takenDownById: null,
        takenDownAt: null,
      }),
    );
    expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
      null,
      STAFF_ID,
      'studio_release_restored',
      undefined,
      RELEASE_ID,
      undefined,
      manager,
      null,
    );
  });

  it('restores a draft that was taken down to draft, so restore never publishes', async () => {
    release = {
      ...release!,
      status: StudioReleaseStatus.TakenDown,
      publishedAt: null,
    };
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'draft' }),
    );
  });

  it('restores nothing for a release that is not taken down', async () => {
    await service.restore(STAFF_ID, RELEASE_ID);
    expect(manager.save).not.toHaveBeenCalled();
  });

  it('restore refuses while a dispute is open', async () => {
    release = { ...release!, status: StudioReleaseStatus.TakenDown };
    openDispute = { id: 'dispute-1' };

    const failure = await service
      .restore(STAFF_ID, RELEASE_ID)
      .catch((error: unknown) => error as HttpException);

    expect(failure).toBeInstanceOf(HttpException);
    expect((failure as HttpException).getStatus()).toBe(409);
    expect((failure as HttpException).getResponse()).toEqual({
      statusCode: 409,
      code: 'studio_release_has_open_dispute',
      message:
        'This release has an open dispute. Decide it in Studio flag review.',
    });
    expect(manager.save).not.toHaveBeenCalled();
    expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
    expect(catalog.getReleaseForStaff).not.toHaveBeenCalled();
  });

  it('restore checks for an open dispute after the release lock and restores when none is open', async () => {
    release = { ...release!, status: StudioReleaseStatus.TakenDown };

    await service.restore(STAFF_ID, RELEASE_ID);

    expect(
      manager.findOne.mock.calls.map(([entity]: [unknown]) => entity),
    ).toEqual([StudioRelease, StudioReleaseDispute]);
    expect(manager.findOne).toHaveBeenCalledWith(StudioReleaseDispute, {
      where: {
        releaseId: RELEASE_ID,
        status: StudioReleaseDisputeStatus.Open,
      },
      select: { id: true },
    });
    expect(manager.save).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'published' }),
    );
  });

  it('writes the canonical release id in the takedown and restore notes', async () => {
    const callerReleaseId = RELEASE_ID.toUpperCase();

    await service.takedown(STAFF_ID, callerReleaseId, 'Uploaded twice');
    await service.restore(STAFF_ID, callerReleaseId);

    const notes = modAudit.writeAuditLog.mock.calls.map(
      (call: unknown[]) => call[4],
    );
    expect(notes).toEqual([`${RELEASE_ID}: Uploaded twice`, RELEASE_ID]);
  });

  it('answers 404 for a missing release', async () => {
    release = null;
    await expect(
      service.takedown(STAFF_ID, RELEASE_ID, 'Reason'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.restore(STAFF_ID, RELEASE_ID)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('needs a reason of 1 to 500 characters after trimming', async () => {
    const errorsFor = async (reason: unknown) =>
      (await validate(plainToInstance(TakedownStudioReleaseDto, { reason })))
        .length;
    expect(await errorsFor('Uploaded twice')).toBe(0);
    expect(await errorsFor('   ')).toBe(1);
    expect(await errorsFor('x'.repeat(501))).toBe(1);
  });

  // Studio open demo pages.
  describe('owner notices', () => {
    it('tells the owners after the takedown commits', async () => {
      await service.takedown(STAFF_ID, RELEASE_ID, 'Uploaded twice');
      expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'studio.release.taken_down',
        { releaseId: RELEASE_ID },
      );
      expect(emitsInsideTransaction).toBe(0);
    });

    it('says nothing for a release that was already down, or for a restore', async () => {
      release = { ...release!, status: StudioReleaseStatus.TakenDown };
      await service.takedown(STAFF_ID, RELEASE_ID, 'Again');
      await service.restore(STAFF_ID, RELEASE_ID);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('says nothing when the takedown fails', async () => {
      release = null;
      await expect(
        service.takedown(STAFF_ID, RELEASE_ID, 'Reason'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });
  });

  describe('the open and escalated reports about the release', () => {
    it('resolves every open or escalated report in the same transaction, links the audit row to the named one, and tells the reporters after commit', async () => {
      takedownReports.resolveWithin.mockResolvedValue({
        kind: 'resolved',
        reports: resolvedReports,
      });

      await service.takedown(
        STAFF_ID,
        RELEASE_ID,
        'Uploaded without the rights',
        REPORT_ID,
      );

      expect(takedownReports.resolveWithin).toHaveBeenCalledWith(manager, {
        releaseId: RELEASE_ID,
        actorId: STAFF_ID,
        reason: 'Uploaded without the rights',
        reportId: REPORT_ID,
        isOwnerNoticeSent: true,
      });
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        REPORT_ID,
        STAFF_ID,
        'studio_release_taken_down',
        undefined,
        `${RELEASE_ID}: Uploaded without the rights`,
        undefined,
        manager,
        null,
      );
      expect(takedownReports.notifyReportersBestEffort).toHaveBeenCalledWith(
        resolvedReports,
        STAFF_ID,
      );
    });

    it('resolves the open reports of a takedown that names none, and keeps the audit row unlinked', async () => {
      takedownReports.resolveWithin.mockResolvedValue({
        kind: 'resolved',
        reports: resolvedReports,
      });

      await service.takedown(STAFF_ID, RELEASE_ID, 'Reason');

      expect(takedownReports.resolveWithin).toHaveBeenCalledWith(manager, {
        releaseId: RELEASE_ID,
        actorId: STAFF_ID,
        reason: 'Reason',
        reportId: undefined,
        isOwnerNoticeSent: true,
      });
      expect(modAudit.writeAuditLog.mock.calls[0]![0]).toBeNull();
      expect(takedownReports.notifyReportersBestEffort).toHaveBeenCalledWith(
        resolvedReports,
        STAFF_ID,
      );
    });

    it('tells no reporter when no report about the release was open', async () => {
      await service.takedown(STAFF_ID, RELEASE_ID, 'Reason');
      expect(takedownReports.notifyReportersBestEffort).not.toHaveBeenCalled();
    });

    it('refuses a named report about something else and leaves the release up', async () => {
      takedownReports.resolveWithin.mockResolvedValue({ kind: 'mismatch' });

      const failure = await service
        .takedown(STAFF_ID, RELEASE_ID, 'Reason', REPORT_ID)
        .catch((error: unknown) => error as HttpException);

      expect(failure).toBeInstanceOf(HttpException);
      expect((failure as HttpException).getStatus()).toBe(422);
      expect((failure as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_takedown_report_mismatch' }),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(takedownReports.notifyReportersBestEffort).not.toHaveBeenCalled();
    });

    it('refuses a named report someone already resolved', async () => {
      takedownReports.resolveWithin.mockResolvedValue({ kind: 'not_open' });

      const failure = await service
        .takedown(STAFF_ID, RELEASE_ID, 'Reason', REPORT_ID)
        .catch((error: unknown) => error as HttpException);

      expect((failure as HttpException).getStatus()).toBe(409);
      expect((failure as HttpException).getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_takedown_report_not_open' }),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('resolves the open reports of a release that is already down, with no second takedown and no owner notice', async () => {
      release = {
        ...release!,
        status: StudioReleaseStatus.TakenDown,
        takedownReason: 'First',
      };
      takedownReports.resolveWithin.mockResolvedValue({
        kind: 'resolved',
        reports: resolvedReports,
      });

      await service.takedown(STAFF_ID, RELEASE_ID, 'Second', REPORT_ID);

      expect(takedownReports.resolveWithin).toHaveBeenCalledTimes(1);
      expect(takedownReports.resolveWithin).toHaveBeenCalledWith(manager, {
        releaseId: RELEASE_ID,
        actorId: STAFF_ID,
        reason: 'Second',
        reportId: REPORT_ID,
        isOwnerNoticeSent: false,
      });
      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
      expect(takedownReports.notifyReportersBestEffort).toHaveBeenCalledWith(
        resolvedReports,
        STAFF_ID,
      );
    });

    it('takes a report id only as a uuid', async () => {
      const errorsFor = async (reportId: unknown) =>
        (
          await validate(
            plainToInstance(TakedownStudioReleaseDto, {
              reason: 'Uploaded twice',
              reportId,
            }),
          )
        ).length;
      expect(await errorsFor(undefined)).toBe(0);
      expect(await errorsFor(REPORT_ID)).toBe(0);
      expect(await errorsFor('report-1')).toBe(1);
      expect(await errorsFor(42)).toBe(1);
    });
  });

  describe('restoreWithin', () => {
    it('restores inside the caller transaction and says the release changed', async () => {
      release = { ...release!, status: StudioReleaseStatus.TakenDown };
      expect(
        await service.restoreWithin(
          manager as unknown as EntityManager,
          STAFF_ID,
          RELEASE_ID,
        ),
      ).toBe(true);
      expect(manager.findOne).toHaveBeenCalledWith(StudioRelease, {
        where: { id: RELEASE_ID },
        lock: { mode: 'pessimistic_write' },
      });
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'published' }),
      );
    });

    it('says nothing changed for a release that is not taken down', async () => {
      expect(
        await service.restoreWithin(
          manager as unknown as EntityManager,
          STAFF_ID,
          RELEASE_ID,
        ),
      ).toBe(false);
      expect(manager.save).not.toHaveBeenCalled();
    });
  });

  // Studio v3: the CHECK keeps `publish_at` on scheduled rows only.
  it('clears the publish time of a scheduled release it takes down, and restore returns it to draft', async () => {
    release = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Scheduled,
      publishedAt: null,
      publishAt: new Date('2026-12-01T18:00:00.000Z'),
      takenDownAt: null,
      takenDownById: null,
      takedownReason: null,
    } as StudioRelease;
    await service.takedown(STAFF_ID, RELEASE_ID, 'Not theirs to share');
    const takenDown = manager.save.mock.calls[0]![0] as StudioRelease;
    expect(takenDown.status).toBe('taken_down');
    expect(takenDown.publishAt).toBeNull();

    await service.restore(STAFF_ID, RELEASE_ID);
    const restored = manager.save.mock.calls[1]![0] as StudioRelease;
    expect(restored.status).toBe('draft');
  });

  it('clears a release date that scheduling filled when it takes the release down, and keeps a typed one', async () => {
    const publishAt = new Date('2026-12-01T18:00:00.000Z');
    const scheduledRelease = (releasedOn: string) =>
      ({
        id: RELEASE_ID,
        status: StudioReleaseStatus.Scheduled,
        publishedAt: null,
        publishAt,
        releasedOn,
        takenDownAt: null,
        takenDownById: null,
        takedownReason: null,
      }) as StudioRelease;
    release = scheduledRelease('2026-12-01');
    await service.takedown(STAFF_ID, RELEASE_ID, 'Not theirs to share');
    expect(
      (manager.save.mock.calls[0]![0] as StudioRelease).releasedOn,
    ).toBeNull();

    release = scheduledRelease('2026-11-20');
    await service.takedown(STAFF_ID, RELEASE_ID, 'Not theirs to share');
    expect((manager.save.mock.calls[1]![0] as StudioRelease).releasedOn).toBe(
      '2026-11-20',
    );
  });

  it('clears the preview link it takes down, and restore brings back no link', async () => {
    release = {
      id: RELEASE_ID,
      status: StudioReleaseStatus.Published,
      publishedAt: PUBLISHED_AT,
      previewToken: 'b'.repeat(64),
      previewLinkCreatedAt: new Date('2026-10-01T09:00:00.000Z'),
      takenDownAt: null,
      takenDownById: null,
      takedownReason: null,
    } as StudioRelease;
    await service.takedown(STAFF_ID, RELEASE_ID, 'Not theirs to share');
    const takenDown = manager.save.mock.calls[0]![0] as StudioRelease;
    expect(takenDown.previewToken).toBeNull();
    expect(takenDown.previewLinkCreatedAt).toBeNull();

    await service.restore(STAFF_ID, RELEASE_ID);
    const restored = manager.save.mock.calls[1]![0] as StudioRelease;
    expect(restored.status).toBe('published');
    expect(restored.previewToken).toBeNull();
    expect(restored.previewLinkCreatedAt).toBeNull();
  });
});
