import { HttpException, NotFoundException } from '@nestjs/common';
import { DataSource, EntityManager, Repository } from 'typeorm';
import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { RESTORE_WITHHELD_TRACK_SQL } from './studio-claim-store';
import {
  FILEABLE_TRACK_SQL,
  LOCK_RELEASE_OF_TRACK_SQL,
  RELEASE_OWNER_SQL,
  StudioClaimsService,
} from './studio-claims.service';
import { encodeStudioCursor } from './studio-cursor';
import { releasedTrackAudioSql } from './studio-playlist-visibility';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';
import { listenablePersonaSql } from './studio-visibility';

const CLAIMANT_ID = 'cc000000-0000-4000-8000-000000000001';
const OWNER_ID = 'cc000000-0000-4000-8000-000000000002';
const CLAIM_ID = 'cc100000-0000-4000-8000-000000000001';
const TRACK_ID = 'cc200000-0000-4000-8000-000000000001';
const RELEASE_ID = 'cc300000-0000-4000-8000-000000000001';

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
): StudioCopyrightClaim => ({
  id: CLAIM_ID,
  trackId: TRACK_ID,
  releaseId: RELEASE_ID,
  claimantId: CLAIMANT_ID,
  claimantRole: StudioClaimantRole.RightsHolder,
  originalWork: 'Saudade',
  originalLink: null,
  details: 'The hook',
  goodFaithAt: new Date('2026-10-14T09:00:00.000Z'),
  status: StudioCopyrightClaimStatus.Submitted,
  counterNote: null,
  counteredAt: null,
  claimantReply: null,
  repliedAt: null,
  staffNote: null,
  decidedById: null,
  acceptedAt: null,
  decidedAt: null,
  trackTitleAtFiling: 'Opening',
  artistNameAtFiling: 'Night Shift',
  isSevered: false,
  createdAt: new Date('2026-10-14T09:00:00.000Z'),
  updatedAt: new Date('2026-10-14T09:00:00.000Z'),
  ...overrides,
});

const withContext = (claim: StudioCopyrightClaim): StudioCopyrightClaim =>
  ({
    ...claim,
    track: { id: TRACK_ID, title: 'Opening' },
    release: {
      id: RELEASE_ID,
      title: 'Lisbon at four',
      subprofile: {
        id: 'cc400000-0000-4000-8000-000000000001',
        handle: 'night-shift',
        displayName: 'Night Shift',
        kind: 'dj',
        avatarUrl: null,
      },
    },
  }) as unknown as StudioCopyrightClaim;

describe('StudioClaimsService', () => {
  let storedClaim: StudioCopyrightClaim | null;
  let trackRow: Partial<StudioTrack> | null;
  let lockedReleaseRows: { id: string }[];
  let fileableRows: {
    release_id: string;
    artist_name: string;
    is_owner: boolean;
  }[];
  let ownerRows: unknown[];
  let manager: {
    findOne: jest.Mock;
    query: jest.Mock;
    exists: jest.Mock;
    count: jest.Mock;
    insert: jest.Mock;
    save: jest.Mock;
  };
  let claims: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let dataSource: { transaction: jest.Mock; query: jest.Mock };
  let notices: { claimWithdrawn: jest.Mock; claimCountered: jest.Mock };
  let noticesInsideTransaction: number;
  let service: StudioClaimsService;

  beforeEach(() => {
    storedClaim = claimRow();
    trackRow = { id: TRACK_ID, releaseId: RELEASE_ID, title: 'Opening' };
    lockedReleaseRows = [{ id: RELEASE_ID }];
    fileableRows = [
      { release_id: RELEASE_ID, artist_name: 'Night Shift', is_owner: false },
    ];
    ownerRows = [{ is_owner: 1 }];
    manager = {
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(
          entity === StudioTrack ? trackRow : storedClaim && { ...storedClaim },
        ),
      ),
      query: jest.fn((sql: string) =>
        Promise.resolve(
          sql === FILEABLE_TRACK_SQL
            ? fileableRows
            : sql === LOCK_RELEASE_OF_TRACK_SQL
              ? lockedReleaseRows
              : [],
        ),
      ),
      exists: jest.fn().mockResolvedValue(false),
      count: jest.fn().mockResolvedValue(0),
      insert: jest.fn().mockResolvedValue({ identifiers: [{ id: CLAIM_ID }] }),
      save: jest.fn((row: object) => Promise.resolve(row)),
    };
    claims = {
      findOne: jest.fn(() =>
        Promise.resolve(storedClaim && withContext(storedClaim)),
      ),
      createQueryBuilder: jest.fn(),
    };
    notices = {
      claimWithdrawn: jest.fn().mockResolvedValue(undefined),
      claimCountered: jest.fn().mockResolvedValue(undefined),
    };
    noticesInsideTransaction = 0;
    dataSource = {
      transaction: jest.fn(
        async (work: (inner: EntityManager) => Promise<unknown>) => {
          const result = await work(manager as unknown as EntityManager);
          noticesInsideTransaction +=
            notices.claimWithdrawn.mock.calls.length +
            notices.claimCountered.mock.calls.length;
          return result;
        },
      ),
      query: jest.fn(() => Promise.resolve(ownerRows)),
    };
    service = new StudioClaimsService(
      dataSource as unknown as DataSource,
      claims as unknown as Repository<StudioCopyrightClaim>,
      notices as unknown as StudioSafetyNoticesService,
    );
  });

  const fileBody = {
    claimantRole: StudioClaimantRole.Authorised,
    originalWork: 'Saudade by Ana Moura',
    originalLink: null,
    details: 'The hook from 0:40 is lifted whole',
    goodFaith: true as const,
  };

  describe('file', () => {
    it('files a submitted claim under the track lock and answers the claimant view', async () => {
      const response = await service.file(CLAIMANT_ID, TRACK_ID, fileBody);

      expect(manager.findOne.mock.calls[0]).toEqual([
        StudioTrack,
        { where: { id: TRACK_ID }, lock: { mode: 'pessimistic_write' } },
      ]);
      expect(manager.query).toHaveBeenCalledWith(FILEABLE_TRACK_SQL, [
        TRACK_ID,
        CLAIMANT_ID,
      ]);
      const [[entity, inserted]] = manager.insert.mock.calls as [
        [unknown, Record<string, unknown>],
      ];
      expect(entity).toBe(StudioCopyrightClaim);
      expect(inserted).toEqual({
        trackId: TRACK_ID,
        releaseId: RELEASE_ID,
        claimantId: CLAIMANT_ID,
        claimantRole: 'authorised',
        originalWork: 'Saudade by Ana Moura',
        originalLink: null,
        details: 'The hook from 0:40 is lifted whole',
        goodFaithAt: expect.any(Date),
        status: 'submitted',
        trackTitleAtFiling: 'Opening',
        artistNameAtFiling: 'Night Shift',
      });
      expect(response.id).toBe(CLAIM_ID);
      expect(response.track.title).toBe('Opening');
      expect(claims.findOne).toHaveBeenCalledWith({
        where: { id: CLAIM_ID, claimantId: CLAIMANT_ID },
        relations: { track: true, release: { subprofile: true } },
      });
    });

    it('locks the release row before the track row', async () => {
      await service.file(CLAIMANT_ID, TRACK_ID, fileBody);

      const queryCalls = manager.query.mock.calls as Array<[string, unknown[]]>;
      const releaseLockIndex = queryCalls.findIndex(
        ([sql]) => sql === LOCK_RELEASE_OF_TRACK_SQL,
      );
      expect(releaseLockIndex).toBeGreaterThanOrEqual(0);
      expect(queryCalls[releaseLockIndex]?.[1]).toEqual([TRACK_ID]);
      expect(
        manager.query.mock.invocationCallOrder[releaseLockIndex],
      ).toBeLessThan(manager.findOne.mock.invocationCallOrder[0]!);
      expect(LOCK_RELEASE_OF_TRACK_SQL).toContain('FOR KEY SHARE OF "release"');
      expect(LOCK_RELEASE_OF_TRACK_SQL).toContain(
        'SELECT "track"."release_id" FROM "studio_tracks" "track" WHERE "track"."id" = $1',
      );
    });

    it('answers 404 when the release is gone or the track moved under the release lock', async () => {
      lockedReleaseRows = [];
      await expect(
        service.file(CLAIMANT_ID, TRACK_ID, fileBody),
      ).rejects.toThrow(new NotFoundException('Track not found'));
      expect(manager.findOne).not.toHaveBeenCalled();

      lockedReleaseRows = [{ id: 'cc300000-0000-4000-8000-000000000009' }];
      await expect(
        service.file(CLAIMANT_ID, TRACK_ID, fileBody),
      ).rejects.toThrow(new NotFoundException('Track not found'));
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('keeps the track title and artist name at filing', async () => {
      fileableRows = [
        {
          release_id: RELEASE_ID,
          artist_name: 'N'.repeat(130),
          is_owner: false,
        },
      ];
      await service.file(CLAIMANT_ID, TRACK_ID, fileBody);

      const [[, inserted]] = manager.insert.mock.calls as [
        [unknown, Record<string, unknown>],
      ];
      expect(inserted.trackTitleAtFiling).toBe('Opening');
      expect(inserted.artistNameAtFiling).toBe('N'.repeat(120));
      expect(FILEABLE_TRACK_SQL).toContain(
        '"persona"."display_name" AS "artist_name"',
      );
    });

    it('checks the track as the claimant hears it, withheld or not', () => {
      expect(FILEABLE_TRACK_SQL).toContain(
        releasedTrackAudioSql('track', 'release'),
      );
      expect(FILEABLE_TRACK_SQL).toContain(listenablePersonaSql('persona'));
      expect(FILEABLE_TRACK_SQL).toContain('"blocks"');
      expect(FILEABLE_TRACK_SQL).not.toContain('withheld_at');
    });

    it('answers 404 for an unknown track and for one the claimant cannot hear', async () => {
      trackRow = null;
      await expect(
        service.file(CLAIMANT_ID, TRACK_ID, fileBody),
      ).rejects.toThrow(new NotFoundException('Track not found'));
      trackRow = { id: TRACK_ID, releaseId: RELEASE_ID, title: 'Opening' };
      fileableRows = [];
      await expect(
        service.file(CLAIMANT_ID, TRACK_ID, fileBody),
      ).rejects.toThrow(new NotFoundException('Track not found'));
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses an owner of the track', async () => {
      fileableRows = [
        { release_id: RELEASE_ID, artist_name: 'Night Shift', is_owner: true },
      ];
      expect(await codeOf(service.file(OWNER_ID, TRACK_ID, fileBody))).toBe(
        'studio_claim_own_track',
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('refuses a second live claim by the same member on the track', async () => {
      manager.exists.mockResolvedValue(true);
      expect(await codeOf(service.file(CLAIMANT_ID, TRACK_ID, fileBody))).toBe(
        'studio_claim_exists',
      );
      expect(manager.insert).not.toHaveBeenCalled();
    });

    it('answers the same refusal when the unique index catches a race', async () => {
      manager.insert.mockRejectedValue({
        code: '23505',
        constraint: 'UQ_studio_copyright_claims_live_track_claimant',
      });
      expect(await codeOf(service.file(CLAIMANT_ID, TRACK_ID, fileBody))).toBe(
        'studio_claim_exists',
      );
    });

    it('refuses an eleventh live claim', async () => {
      manager.count.mockResolvedValue(10);
      expect(await codeOf(service.file(CLAIMANT_ID, TRACK_ID, fileBody))).toBe(
        'studio_claim_limit',
      );
    });
  });

  describe('listMine', () => {
    it("pages the claimant's own claims, newest first, from a cursor", async () => {
      const queryBuilder: Record<string, jest.Mock> = {};
      for (const method of [
        'leftJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'limit',
      ]) {
        queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
      }
      queryBuilder.getMany = jest
        .fn()
        .mockResolvedValue([withContext(claimRow())]);
      claims.createQueryBuilder.mockReturnValue(queryBuilder);
      const cursor = encodeStudioCursor({
        publishedAt: new Date('2026-10-15T09:00:00.000Z'),
        id: CLAIM_ID,
      });

      const page = await service.listMine(CLAIMANT_ID, cursor);

      expect(queryBuilder.where).toHaveBeenCalledWith(
        'claim.claimantId = :claimantId',
        { claimantId: CLAIMANT_ID },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        '("claim"."created_at", "claim"."id") < (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: new Date('2026-10-15T09:00:00.000Z'),
          cursorId: CLAIM_ID,
        },
      );
      expect(queryBuilder.orderBy).toHaveBeenCalledWith(
        'claim.createdAt',
        'DESC',
      );
      expect(queryBuilder.limit).toHaveBeenCalledWith(21);
      expect(page.items.map((item) => item.id)).toEqual([CLAIM_ID]);
      expect(page.pageInfo).toEqual({ hasMore: false, nextCursor: null });
    });

    it('serves a severed claim from the names kept at filing, with no live reference', async () => {
      const severedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Accepted,
        acceptedAt: new Date('2026-10-14T10:00:00.000Z'),
        isSevered: true,
      });
      const queryBuilder: Record<string, jest.Mock> = {};
      for (const method of [
        'leftJoinAndSelect',
        'where',
        'andWhere',
        'orderBy',
        'addOrderBy',
        'limit',
      ]) {
        queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
      }
      // The cascaded rows now carry the pseudonymous persona.
      queryBuilder.getMany = jest.fn().mockResolvedValue([
        {
          ...severedClaim,
          track: {
            id: 'cc200000-0000-4000-8000-000000000099',
            title: 'Renamed',
          },
          release: {
            id: 'cc300000-0000-4000-8000-000000000099',
            title: 'Fresh release',
            subprofile: {
              id: 'cc400000-0000-4000-8000-000000000099',
              handle: 'quiet-hours',
              displayName: 'Quiet Hours',
              kind: 'dj',
              avatarUrl: null,
            },
          },
        },
      ]);
      claims.createQueryBuilder.mockReturnValue(queryBuilder);

      const page = await service.listMine(CLAIMANT_ID, undefined);

      const [response] = page.items;
      expect(response?.track).toEqual({
        id: null,
        title: 'Opening',
        release: { id: null, title: null },
        artist: null,
        artistName: 'Night Shift',
      });
      const serialized = JSON.stringify(response);
      expect(serialized).not.toContain('Quiet Hours');
      expect(serialized).not.toContain('quiet-hours');
      expect(serialized).not.toContain('000000000099');
    });
  });

  describe('reply', () => {
    it("answers 404 for someone else's claim", async () => {
      storedClaim = null;
      await expect(service.reply(CLAIMANT_ID, CLAIM_ID, 'No')).rejects.toThrow(
        new NotFoundException('Claim not found'),
      );
      expect(manager.findOne.mock.calls[0]?.[1]).toEqual({
        where: { id: CLAIM_ID, claimantId: CLAIMANT_ID },
        select: { id: true, trackId: true },
      });
    });

    it('refuses a reply before a counter-notice and a second reply', async () => {
      storedClaim = claimRow({ status: StudioCopyrightClaimStatus.Accepted });
      expect(await codeOf(service.reply(CLAIMANT_ID, CLAIM_ID, 'No'))).toBe(
        'studio_claim_not_countered',
      );
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Countered,
        counterNote: 'Mine',
        counteredAt: new Date(),
        claimantReply: 'No',
        repliedAt: new Date(),
      });
      expect(await codeOf(service.reply(CLAIMANT_ID, CLAIM_ID, 'Again'))).toBe(
        'studio_claim_already_replied',
      );
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('records one reply to a counter-notice', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Countered,
        acceptedAt: new Date(),
        counterNote: 'Mine',
        counteredAt: new Date(),
      });
      await service.reply(CLAIMANT_ID, CLAIM_ID, 'The sample is mine');
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({
          status: 'countered',
          claimantReply: 'The sample is mine',
          repliedAt: expect.any(Date),
        }),
      );
    });
  });

  describe('withdraw', () => {
    it('withdraws a submitted claim silently, with no restore', async () => {
      await service.withdraw(CLAIMANT_ID, CLAIM_ID);
      expect(manager.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: 'withdrawn' }),
      );
      expect(manager.query).not.toHaveBeenCalledWith(
        RESTORE_WITHHELD_TRACK_SQL,
        expect.anything(),
      );
      expect(notices.claimWithdrawn).not.toHaveBeenCalled();
    });

    it('restores the track when a held claim is withdrawn and tells the owners after commit', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Countered,
        acceptedAt: new Date(),
        counterNote: 'Mine',
        counteredAt: new Date(),
      });
      await service.withdraw(CLAIMANT_ID, CLAIM_ID);
      expect(manager.query).toHaveBeenCalledWith(RESTORE_WITHHELD_TRACK_SQL, [
        TRACK_ID,
      ]);
      const saveOrder = manager.save.mock.invocationCallOrder[0]!;
      const restoreIndex = manager.query.mock.calls.findIndex(
        ([sql]) => sql === RESTORE_WITHHELD_TRACK_SQL,
      );
      expect(saveOrder).toBeLessThan(
        manager.query.mock.invocationCallOrder[restoreIndex]!,
      );
      expect(notices.claimWithdrawn).toHaveBeenCalledWith(CLAIM_ID, TRACK_ID);
      expect(noticesInsideTransaction).toBe(0);
    });

    it('refuses a closed claim', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Declined,
        staffNote: 'Not enough',
        decidedAt: new Date(),
      });
      expect(await codeOf(service.withdraw(CLAIMANT_ID, CLAIM_ID))).toBe(
        'studio_claim_not_live',
      );
    });
  });

  describe('counter', () => {
    it.each([
      StudioCopyrightClaimStatus.Submitted,
      StudioCopyrightClaimStatus.Declined,
      StudioCopyrightClaimStatus.Withdrawn,
    ])(
      'answers 404 for a counter on a claim the owner may not see: %s',
      async (status) => {
        storedClaim = claimRow({ status });
        await expect(
          service.counter(OWNER_ID, CLAIM_ID, 'I wrote it'),
        ).rejects.toThrow(new NotFoundException('Claim not found'));
        expect(dataSource.transaction).not.toHaveBeenCalled();
      },
    );

    it('answers 404 to a member who does not run the persona', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Accepted,
        acceptedAt: new Date(),
      });
      ownerRows = [];
      await expect(
        service.counter(CLAIMANT_ID, CLAIM_ID, 'I wrote it'),
      ).rejects.toThrow(new NotFoundException('Claim not found'));
      expect(dataSource.query).toHaveBeenCalledWith(RELEASE_OWNER_SQL, [
        RELEASE_ID,
        CLAIMANT_ID,
      ]);
    });

    it('refuses a second counter-notice', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Countered,
        acceptedAt: new Date(),
        counterNote: 'Mine',
        counteredAt: new Date(),
      });
      expect(await codeOf(service.counter(OWNER_ID, CLAIM_ID, 'Again'))).toBe(
        'studio_claim_not_accepted',
      );
    });

    it('records the counter-notice with no member id and tells the claimant after commit', async () => {
      storedClaim = claimRow({
        status: StudioCopyrightClaimStatus.Accepted,
        acceptedAt: new Date('2026-10-14T10:00:00.000Z'),
      });

      const ownerClaim = await service.counter(
        OWNER_ID,
        CLAIM_ID,
        'I wrote every bar',
      );

      const [saved] = manager.save.mock.calls[0] as [StudioCopyrightClaim];
      expect(saved).toEqual(
        expect.objectContaining({
          status: 'countered',
          counterNote: 'I wrote every bar',
          counteredAt: expect.any(Date),
        }),
      );
      expect(JSON.stringify(saved)).not.toContain(OWNER_ID);
      expect(notices.claimCountered).toHaveBeenCalledWith(
        CLAIM_ID,
        CLAIMANT_ID,
        TRACK_ID,
      );
      expect(noticesInsideTransaction).toBe(0);
      expect(ownerClaim.status).toBe('countered');
      expect(JSON.stringify(ownerClaim)).not.toContain(CLAIMANT_ID);
    });
  });
});
