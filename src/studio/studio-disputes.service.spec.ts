import { HttpException, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  StudioReleaseDispute,
  StudioReleaseDisputeStatus,
} from './entities/studio-release-dispute.entity';
import {
  StudioRelease,
  StudioReleaseStatus,
} from './entities/studio-release.entity';
import { StudioCatalogService } from './studio-catalog.service';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import { StudioDisputesService } from './studio-disputes.service';
import { StudioModerationService } from './studio-moderation.service';
import { StudioOwnershipService } from './studio-ownership.service';

const OWNER_ID = 'c1000000-0000-4000-8000-000000000001';
const STAFF_ID = 'c1000000-0000-4000-8000-000000000002';
const PERSONA_ID = 'c2000000-0000-4000-8000-000000000001';
const RELEASE_ID = 'c3000000-0000-4000-8000-000000000001';
const DISPUTE_ID = 'c4000000-0000-4000-8000-000000000001';

const summary = {
  id: RELEASE_ID,
  title: 'Lisbon at four',
  status: StudioReleaseStatus.TakenDown,
  takedownReason: 'Uploaded without the rights',
  takenDownAt: '2026-10-12T08:00:00.000Z',
} as StudioAdminReleaseSummary;

const failureOf = async (pending: Promise<unknown>): Promise<HttpException> => {
  try {
    await pending;
  } catch (error) {
    return error as HttpException;
  }
  throw new Error('Expected the call to throw');
};

describe('StudioDisputesService', () => {
  let releaseRow: StudioRelease;
  let disputeRow: StudioReleaseDispute | null;
  let manager: {
    findOne: jest.Mock;
    find: jest.Mock;
    insert: jest.Mock;
    save: jest.Mock;
  };
  let disputes: { findOne: jest.Mock };
  let ownership: { lockReleaseForWrite: jest.Mock };
  let catalog: { getRelease: jest.Mock; staffSummariesByReleaseId: jest.Mock };
  let moderation: { restoreWithin: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let eventEmitter: { emit: jest.Mock };
  let emitsInsideTransaction: number;
  let service: StudioDisputesService;

  beforeEach(() => {
    releaseRow = {
      id: RELEASE_ID,
      subprofileId: PERSONA_ID,
      status: StudioReleaseStatus.TakenDown,
    } as StudioRelease;
    disputeRow = {
      id: DISPUTE_ID,
      releaseId: RELEASE_ID,
      note: 'I hold the rights to every recording',
      status: StudioReleaseDisputeStatus.Open,
      staffReply: null,
      decidedById: null,
      createdAt: new Date('2026-10-12T09:00:00.000Z'),
      decidedAt: null,
    };
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioReleaseDispute
            ? disputeRow && { ...disputeRow }
            : releaseRow,
        ),
      ),
      find: jest.fn().mockResolvedValue([]),
      insert: jest
        .fn()
        .mockResolvedValue({ identifiers: [{ id: DISPUTE_ID }] }),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    disputes = {
      findOne: jest.fn(() => Promise.resolve(disputeRow)),
    };
    ownership = {
      lockReleaseForWrite: jest.fn(() =>
        Promise.resolve({
          release: releaseRow,
          persona: { id: PERSONA_ID, kind: 'dj' },
        }),
      ),
    };
    catalog = {
      getRelease: jest
        .fn()
        .mockResolvedValue({ id: RELEASE_ID, canDispute: false }),
      staffSummariesByReleaseId: jest.fn(() =>
        Promise.resolve(new Map([[RELEASE_ID, summary]])),
      ),
    };
    moderation = { restoreWithin: jest.fn().mockResolvedValue(true) };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
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
    service = new StudioDisputesService(
      dataSource as unknown as DataSource,
      disputes as unknown as Repository<StudioReleaseDispute>,
      ownership as unknown as StudioOwnershipService,
      catalog as unknown as StudioCatalogService,
      moderation as unknown as StudioModerationService,
      modAudit as unknown as ModAuditService,
      eventEmitter as unknown as EventEmitter2,
    );
  });

  describe('file', () => {
    it('files a dispute under the release lock and answers the owner view', async () => {
      const response = await service.file(
        OWNER_ID,
        RELEASE_ID,
        'I hold the rights to every recording',
      );

      expect(ownership.lockReleaseForWrite).toHaveBeenCalledWith(
        manager,
        OWNER_ID,
        RELEASE_ID,
      );
      expect(manager.find).toHaveBeenCalledWith(StudioReleaseDispute, {
        where: { releaseId: RELEASE_ID },
        select: { id: true, status: true },
      });
      expect(manager.insert).toHaveBeenCalledWith(StudioReleaseDispute, {
        releaseId: RELEASE_ID,
        note: 'I hold the rights to every recording',
        status: 'open',
      });
      expect(catalog.getRelease).toHaveBeenCalledWith(OWNER_ID, RELEASE_ID);
      expect(response).toEqual({ id: RELEASE_ID, canDispute: false });
    });

    it('stores the note and the release and no member id', async () => {
      await service.file(OWNER_ID, RELEASE_ID, 'Here is the licence');
      const inserted = manager.insert.mock.calls[0]![1] as Record<
        string,
        unknown
      >;
      expect(Object.keys(inserted).sort()).toEqual([
        'note',
        'releaseId',
        'status',
      ]);
      expect(JSON.stringify(inserted)).not.toContain(OWNER_ID);
    });

    it('refuses a release that is not taken down', async () => {
      releaseRow = { ...releaseRow, status: StudioReleaseStatus.Published };
      const failure = await failureOf(
        service.file(OWNER_ID, RELEASE_ID, 'Note'),
      );
      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_release_not_taken_down' }),
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses a second dispute while one is open', async () => {
      manager.find.mockResolvedValue([
        { id: 'dispute-0', status: StudioReleaseDisputeStatus.Open },
      ]);
      const failure = await failureOf(
        service.file(OWNER_ID, RELEASE_ID, 'Note'),
      );
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_dispute_already_open' }),
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses a fourth dispute over the release life', async () => {
      manager.find.mockResolvedValue(
        ['dispute-1', 'dispute-2', 'dispute-3'].map((id) => ({
          id,
          status: StudioReleaseDisputeStatus.Rejected,
        })),
      );
      const failure = await failureOf(
        service.file(OWNER_ID, RELEASE_ID, 'Note'),
      );
      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_dispute_limit_reached' }),
      );
    });

    it('answers the open conflict when the unique index catches a race', async () => {
      manager.insert.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_studio_release_disputes_open_release',
      });
      const failure = await failureOf(
        service.file(OWNER_ID, RELEASE_ID, 'Note'),
      );
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_dispute_already_open' }),
      );
    });

    it('lets the ownership check answer for anyone who does not own the persona', async () => {
      ownership.lockReleaseForWrite.mockRejectedValue(
        new NotFoundException('Release not found'),
      );
      await expect(
        service.file(STAFF_ID, RELEASE_ID, 'Note'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(manager.insert).not.toHaveBeenCalled();
    });
  });

  describe('uphold and reject', () => {
    it('locks the release before the dispute, the order filing takes', async () => {
      await service.reject(STAFF_ID, DISPUTE_ID, 'The label wrote to us');
      const lookups = manager.findOne.mock.calls.map(
        ([entity, options]: [unknown, { lock?: unknown }]) => [
          entity,
          Boolean(options.lock),
        ],
      );
      expect(lookups).toEqual([
        [StudioReleaseDispute, false],
        [StudioRelease, true],
        [StudioReleaseDispute, true],
      ]);
    });

    it('upholds: restores the release in the same transaction, records the reply and audits with no target', async () => {
      const before = Date.now();

      const result = await service.uphold(
        STAFF_ID,
        DISPUTE_ID,
        'Thanks, the licence checks out',
      );

      expect(moderation.restoreWithin).toHaveBeenCalledWith(
        manager,
        STAFF_ID,
        RELEASE_ID,
      );
      const saved = manager.save.mock.calls[0]![0] as StudioReleaseDispute;
      expect(saved).toEqual(
        expect.objectContaining({
          status: 'upheld',
          staffReply: 'Thanks, the licence checks out',
          decidedById: STAFF_ID,
        }),
      );
      expect(saved.decidedAt!.getTime()).toBeGreaterThanOrEqual(before);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_release_dispute_upheld',
        undefined,
        `${RELEASE_ID}: Thanks, the licence checks out`,
        undefined,
        manager,
        null,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'studio.release.dispute_decided',
        { releaseId: RELEASE_ID, disputeId: DISPUTE_ID, outcome: 'upheld' },
      );
      expect(emitsInsideTransaction).toBe(0);
      expect(result.release).toBe(summary);
    });

    it('rejects: keeps the release down and audits the rejection', async () => {
      await service.reject(STAFF_ID, DISPUTE_ID, 'The label wrote to us');

      expect(moderation.restoreWithin).not.toHaveBeenCalled();
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'rejected',
          staffReply: 'The label wrote to us',
        }),
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_release_dispute_rejected',
        undefined,
        `${RELEASE_ID}: The label wrote to us`,
        undefined,
        manager,
        null,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'studio.release.dispute_decided',
        { releaseId: RELEASE_ID, disputeId: DISPUTE_ID, outcome: 'rejected' },
      );
    });

    it('reject refuses on a live release', async () => {
      releaseRow = { ...releaseRow, status: StudioReleaseStatus.Published };

      const failure = await failureOf(
        service.reject(STAFF_ID, DISPUTE_ID, 'The label wrote to us'),
      );

      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_release_not_taken_down' }),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('uphold on an already-live release records upheld, leaves the release, still emits the decision event', async () => {
      releaseRow = { ...releaseRow, status: StudioReleaseStatus.Published };
      moderation.restoreWithin.mockResolvedValue(false);

      await service.uphold(STAFF_ID, DISPUTE_ID, 'It is back already');

      expect(moderation.restoreWithin).toHaveBeenCalledWith(
        manager,
        STAFF_ID,
        RELEASE_ID,
      );
      expect(manager.save).toHaveBeenCalledTimes(1);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          id: DISPUTE_ID,
          status: 'upheld',
          staffReply: 'It is back already',
        }),
      );
      expect(releaseRow.status).toBe(StudioReleaseStatus.Published);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_release_dispute_upheld',
        undefined,
        `${RELEASE_ID}: It is back already`,
        undefined,
        manager,
        null,
      );
      expect(eventEmitter.emit).toHaveBeenCalledWith(
        'studio.release.dispute_decided',
        { releaseId: RELEASE_ID, disputeId: DISPUTE_ID, outcome: 'upheld' },
      );
      expect(emitsInsideTransaction).toBe(0);
    });

    it('answers 409 when the dispute was already decided', async () => {
      disputeRow = {
        ...disputeRow!,
        status: StudioReleaseDisputeStatus.Upheld,
        staffReply: 'Done',
        decidedAt: new Date(),
      };
      const failure = await failureOf(
        service.reject(STAFF_ID, DISPUTE_ID, 'Second decision'),
      );
      expect(failure.getStatus()).toBe(409);
      expect(failure.getResponse()).toEqual(
        expect.objectContaining({ code: 'studio_dispute_not_open' }),
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(eventEmitter.emit).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown dispute', async () => {
      disputeRow = null;
      await expect(
        service.uphold(STAFF_ID, DISPUTE_ID, 'Reply'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(moderation.restoreWithin).not.toHaveBeenCalled();
    });
  });
});
