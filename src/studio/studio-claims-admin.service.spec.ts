import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { ModAuditService } from '../moderation/mod-audit.service';
import { Profile } from '../users/entities/profile.entity';
import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioCatalogService } from './studio-catalog.service';
import {
  StudioClaimsAdminService,
  claimAuditNote,
} from './studio-claims-admin.service';
import {
  RESTORE_WITHHELD_TRACK_SQL,
  WITHHOLD_TRACK_SQL,
} from './studio-claim-store';
import { encodeStudioCursor } from './studio-cursor';
import { StudioAdminReleaseSummary } from './studio-dispute-response';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';

const STAFF_ID = 'cd000000-0000-4000-8000-000000000001';
const CLAIMANT_ID = 'cd000000-0000-4000-8000-000000000002';
const CLAIM_ID = 'cd100000-0000-4000-8000-000000000001';
const TRACK_ID = 'cd200000-0000-4000-8000-000000000001';
const RELEASE_ID = 'cd300000-0000-4000-8000-000000000001';

const codeOf = async (
  pending: Promise<unknown>,
): Promise<string | undefined> => {
  try {
    await pending;
    return undefined;
  } catch (error) {
    return ((error as HttpException).getResponse() as { code?: string }).code;
  }
};

const claimRow = (
  overrides: Partial<StudioCopyrightClaim> = {},
): StudioCopyrightClaim =>
  ({
    id: CLAIM_ID,
    trackId: TRACK_ID,
    releaseId: RELEASE_ID,
    claimantId: CLAIMANT_ID,
    claimantRole: StudioClaimantRole.RightsHolder,
    originalWork: 'Saudade',
    originalLink: null,
    details: 'The hook',
    status: StudioCopyrightClaimStatus.Submitted,
    counterNote: null,
    counteredAt: null,
    claimantReply: null,
    repliedAt: null,
    staffNote: null,
    decidedById: null,
    acceptedAt: null,
    decidedAt: null,
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    ...overrides,
  }) as StudioCopyrightClaim;

function queryBuilderMock(many: unknown[] = [], raw: unknown[] = []) {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'leftJoinAndSelect',
    'select',
    'addSelect',
    'where',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'groupBy',
    'limit',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(many);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(raw);
  return queryBuilder;
}

describe('StudioClaimsAdminService', () => {
  let storedClaim: StudioCopyrightClaim | null;
  let manager: { findOne: jest.Mock; query: jest.Mock; save: jest.Mock };
  let claims: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let profiles: { find: jest.Mock };
  let catalog: { staffSummariesByReleaseId: jest.Mock };
  let modAudit: { writeAuditLog: jest.Mock };
  let notices: {
    claimAccepted: jest.Mock;
    claimDeclined: jest.Mock;
    claimDecided: jest.Mock;
  };
  let noticesInsideTransaction: number;
  let service: StudioClaimsAdminService;

  const noticeCallCount = (): number =>
    notices.claimAccepted.mock.calls.length +
    notices.claimDeclined.mock.calls.length +
    notices.claimDecided.mock.calls.length;

  beforeEach(() => {
    storedClaim = claimRow();
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack
            ? { id: TRACK_ID, position: 1, title: 'Opening', withheldAt: null }
            : storedClaim && { ...storedClaim },
        ),
      ),
      query: jest.fn().mockResolvedValue([]),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    claims = {
      findOne: jest.fn(() =>
        Promise.resolve(
          storedClaim && {
            ...storedClaim,
            track: {
              id: TRACK_ID,
              position: 1,
              title: 'Opening',
              withheldAt: null,
            },
          },
        ),
      ),
      createQueryBuilder: jest.fn(),
    };
    profiles = {
      find: jest.fn().mockResolvedValue([
        {
          userId: CLAIMANT_ID,
          slug: 'ana',
          firstName: 'Ana',
          lastName: 'Silva',
          pronouns: null,
          avatarUrl: null,
          photoVisible: true,
        },
      ]),
    };
    catalog = {
      staffSummariesByReleaseId: jest.fn(() =>
        Promise.resolve(
          new Map([
            [
              RELEASE_ID,
              {
                id: RELEASE_ID,
                title: 'Lisbon at four',
              } as StudioAdminReleaseSummary,
            ],
          ]),
        ),
      ),
    };
    modAudit = { writeAuditLog: jest.fn().mockResolvedValue('audit-1') };
    notices = {
      claimAccepted: jest.fn().mockResolvedValue(undefined),
      claimDeclined: jest.fn().mockResolvedValue(undefined),
      claimDecided: jest.fn().mockResolvedValue(undefined),
    };
    noticesInsideTransaction = 0;
    const dataSource = {
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) => {
          const result = await work(manager as unknown as EntityManager);
          noticesInsideTransaction += noticeCallCount();
          return result;
        },
      ),
    };
    service = new StudioClaimsAdminService(
      dataSource as unknown as DataSource,
      claims as unknown as Repository<StudioCopyrightClaim>,
      profiles as unknown as Repository<Profile>,
      catalog as unknown as StudioCatalogService,
      modAudit as unknown as ModAuditService,
      notices as unknown as StudioSafetyNoticesService,
    );
  });

  describe('list and counts', () => {
    it('serves the work queue oldest first by default, with the claimant for staff', async () => {
      const queryBuilder = queryBuilderMock([
        {
          ...claimRow(),
          track: {
            id: TRACK_ID,
            position: 1,
            title: 'Opening',
            withheldAt: null,
          },
        },
      ]);
      claims.createQueryBuilder.mockReturnValue(queryBuilder);

      const page = await service.list(undefined, undefined);

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'claim.status IN (:...claimStatuses)',
        { claimStatuses: ['submitted', 'countered'] },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'claim.createdAt',
        'ASC',
      );
      expect(queryBuilder.addOrderBy).toHaveBeenCalledWith('claim.id', 'ASC');
      expect(queryBuilder.limit).toHaveBeenCalledWith(21);
      expect(page.items[0]?.claimant).toEqual({
        id: CLAIMANT_ID,
        slug: 'ana',
        displayName: 'Ana Silva',
        avatarUrl: null,
      });
      expect(page.items[0]?.release.title).toBe('Lisbon at four');
    });

    it('serves one status when asked, after the cursor', async () => {
      const queryBuilder = queryBuilderMock();
      claims.createQueryBuilder.mockReturnValue(queryBuilder);
      const cursor = encodeStudioCursor({
        publishedAt: new Date('2026-10-14T09:00:00.000Z'),
        id: CLAIM_ID,
      });

      await service.list(StudioCopyrightClaimStatus.Withdrawn, cursor);

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'claim.status IN (:...claimStatuses)',
        { claimStatuses: ['withdrawn'] },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '("claim"."created_at", "claim"."id") > (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: new Date('2026-10-14T09:00:00.000Z'),
          cursorId: CLAIM_ID,
        },
      );
    });

    it('counts the submitted and countered claims for the badge', async () => {
      claims.createQueryBuilder.mockReturnValue(
        queryBuilderMock([], [{ status: 'countered', claim_count: '2' }]),
      );
      expect(await service.counts()).toEqual({ submitted: 0, countered: 2 });
    });
  });

  describe('accept', () => {
    it('accepts a submitted claim, withholds the track and audits with no member', async () => {
      const response = await service.accept(STAFF_ID, CLAIM_ID);

      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'accepted',
          acceptedAt: expect.any(Date),
          decidedById: STAFF_ID,
          staffNote: null,
          decidedAt: null,
        }),
      );
      expect(manager.query).toHaveBeenCalledWith(WITHHOLD_TRACK_SQL, [
        TRACK_ID,
      ]);
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_copyright_claim_accepted',
        undefined,
        `claim ${CLAIM_ID} track ${TRACK_ID}`,
        undefined,
        manager,
        null,
      );
      expect(notices.claimAccepted).toHaveBeenCalledWith(CLAIM_ID, TRACK_ID);
      expect(response.id).toBe(CLAIM_ID);
    });

    it('answers 409 when the claim moved on under the lock', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Accepted,
        acceptedAt: new Date(),
      });
      expect(await codeOf(service.accept(STAFF_ID, CLAIM_ID))).toBe(
        'studio_claim_not_submitted',
      );
      expect(manager.save).not.toHaveBeenCalled();
      expect(modAudit.writeAuditLog).not.toHaveBeenCalled();
      expect(notices.claimAccepted).not.toHaveBeenCalled();
    });

    it('answers 404 for an unknown claim', async () => {
      storedClaim = null;
      await expect(service.accept(STAFF_ID, CLAIM_ID)).rejects.toThrow(
        new NotFoundException('Claim not found'),
      );
    });
  });

  describe('decline, uphold and reject', () => {
    it('declines a submitted claim with a note and tells the claimant', async () => {
      await service.decline(STAFF_ID, CLAIM_ID, 'Not enough to go on');
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'declined',
          staffNote: 'Not enough to go on',
          decidedAt: expect.any(Date),
          decidedById: STAFF_ID,
        }),
      );
      expect(manager.query).not.toHaveBeenCalled();
      expect(notices.claimDeclined).toHaveBeenCalledWith(
        CLAIM_ID,
        CLAIMANT_ID,
        TRACK_ID,
      );
      expect(modAudit.writeAuditLog).toHaveBeenCalledWith(
        null,
        STAFF_ID,
        'studio_copyright_claim_declined',
        undefined,
        `claim ${CLAIM_ID} track ${TRACK_ID}: Not enough to go on`,
        undefined,
        manager,
        null,
      );
    });

    it('restores the track on reject and keeps it withheld on uphold', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Countered,
        acceptedAt: new Date(),
        counterNote: 'Mine',
        counteredAt: new Date(),
      });
      await service.uphold(STAFF_ID, CLAIM_ID, 'The sample is unlicensed');
      expect(manager.query).not.toHaveBeenCalledWith(
        RESTORE_WITHHELD_TRACK_SQL,
        expect.anything(),
      );
      expect(notices.claimDecided).toHaveBeenCalledWith(
        CLAIM_ID,
        CLAIMANT_ID,
        TRACK_ID,
        'upheld',
      );

      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Accepted,
        acceptedAt: new Date(),
      });
      await service.reject(STAFF_ID, CLAIM_ID, 'The licence covers it');
      expect(manager.query).toHaveBeenCalledWith(RESTORE_WITHHELD_TRACK_SQL, [
        TRACK_ID,
      ]);
      const restoreIndex = manager.query.mock.calls.findIndex(
        ([sql]) => sql === RESTORE_WITHHELD_TRACK_SQL,
      );
      const rejectSaveOrder = manager.save.mock.invocationCallOrder[1]!;
      expect(rejectSaveOrder).toBeLessThan(
        manager.query.mock.invocationCallOrder[restoreIndex]!,
      );
      expect(notices.claimDecided).toHaveBeenLastCalledWith(
        CLAIM_ID,
        CLAIMANT_ID,
        TRACK_ID,
        'rejected',
      );
    });

    it('refuses to decide a claim that was never accepted', async () => {
      expect(
        await codeOf(service.uphold(STAFF_ID, CLAIM_ID, 'Too early')),
      ).toBe('studio_claim_not_decidable');
      expect(
        await codeOf(service.reject(STAFF_ID, CLAIM_ID, 'Too early')),
      ).toBe('studio_claim_not_decidable');
    });

    it('sends notices after the transaction commits', async () => {
      await service.decline(STAFF_ID, CLAIM_ID, 'Not enough to go on');
      expect(noticesInsideTransaction).toBe(0);
      expect(noticeCallCount()).toBe(1);
    });
  });

  it('writes the audit note the contract spells', () => {
    expect(claimAuditNote(CLAIM_ID, TRACK_ID, null)).toBe(
      `claim ${CLAIM_ID} track ${TRACK_ID}`,
    );
    expect(claimAuditNote(CLAIM_ID, TRACK_ID, 'Licence checks out')).toBe(
      `claim ${CLAIM_ID} track ${TRACK_ID}: Licence checks out`,
    );
  });
});
