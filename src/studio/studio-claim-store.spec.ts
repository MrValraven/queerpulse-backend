import { EntityManager, FindOperator } from 'typeorm';
import {
  StudioClaimantRole,
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL,
  RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL,
  RESTORE_WITHHELD_TRACK_SQL,
  WITHHOLD_TRACK_SQL,
  lockClaimWithTrackWithin,
  ownerClaimsForTracks,
  restoreTracksHeldByClaimantWithin,
  restoreWithheldTrackWithin,
  withholdTrackWithin,
} from './studio-claim-store';

const CLAIM_ID = 'c9000000-0000-4000-8000-000000000001';
const TRACK_ID = 'c9100000-0000-4000-8000-000000000001';
const CLAIMANT_ID = 'c9200000-0000-4000-8000-000000000001';

const claimRow = (
  overrides: Partial<StudioCopyrightClaim> = {},
): StudioCopyrightClaim =>
  ({
    id: CLAIM_ID,
    trackId: TRACK_ID,
    releaseId: 'c9300000-0000-4000-8000-000000000001',
    claimantId: CLAIMANT_ID,
    claimantRole: StudioClaimantRole.Authorised,
    originalWork: 'Saudade',
    originalLink: null,
    details: 'The hook',
    status: StudioCopyrightClaimStatus.Accepted,
    counterNote: null,
    counteredAt: null,
    claimantReply: null,
    repliedAt: null,
    staffNote: null,
    acceptedAt: new Date('2026-10-14T10:00:00.000Z'),
    decidedAt: null,
    createdAt: new Date('2026-10-14T09:00:00.000Z'),
    ...overrides,
  }) as StudioCopyrightClaim;

describe('Studio claim store', () => {
  let manager: { find: jest.Mock; findOne: jest.Mock; query: jest.Mock };

  beforeEach(() => {
    manager = {
      find: jest.fn().mockResolvedValue([claimRow()]),
      findOne: jest.fn((entity: unknown) =>
        Promise.resolve(entity === StudioTrack ? { id: TRACK_ID } : claimRow()),
      ),
      query: jest.fn().mockResolvedValue([]),
    };
  });

  const asManager = (): EntityManager => manager as unknown as EntityManager;

  it('reads owner-visible claims only, newest accepted first', async () => {
    const claims = await ownerClaimsForTracks(asManager(), [TRACK_ID]);

    const [[entity, options]] = manager.find.mock.calls as [
      [
        unknown,
        {
          where: {
            trackId: FindOperator<string[]>;
            status: FindOperator<StudioCopyrightClaimStatus[]>;
          };
          order: Record<string, string>;
        },
      ],
    ];
    expect(entity).toBe(StudioCopyrightClaim);
    expect(options.where.trackId.value).toEqual([TRACK_ID]);
    expect(options.where.status.value).toEqual([
      'accepted',
      'countered',
      'upheld',
      'rejected',
    ]);
    expect(options.order).toEqual({ acceptedAt: 'DESC', id: 'DESC' });
    expect(claims).toHaveLength(1);
    expect(JSON.stringify(claims)).not.toContain(CLAIMANT_ID);
  });

  it('asks nothing for no tracks', async () => {
    expect(await ownerClaimsForTracks(asManager(), [])).toEqual([]);
    expect(manager.find).not.toHaveBeenCalled();
  });

  it('locks the track row before the claim row', async () => {
    const locked = await lockClaimWithTrackWithin(asManager(), CLAIM_ID);

    expect(manager.findOne.mock.calls).toEqual([
      [
        StudioCopyrightClaim,
        { where: { id: CLAIM_ID }, select: { id: true, trackId: true } },
      ],
      [
        StudioTrack,
        { where: { id: TRACK_ID }, lock: { mode: 'pessimistic_write' } },
      ],
      [
        StudioCopyrightClaim,
        { where: { id: CLAIM_ID }, lock: { mode: 'pessimistic_write' } },
      ],
    ]);
    expect(locked?.track).toEqual({ id: TRACK_ID });
    expect(locked?.claim.id).toBe(CLAIM_ID);
  });

  it('scopes the lock to the claimant when one is named', async () => {
    await lockClaimWithTrackWithin(asManager(), CLAIM_ID, CLAIMANT_ID);
    expect(manager.findOne.mock.calls[0]).toEqual([
      StudioCopyrightClaim,
      {
        where: { id: CLAIM_ID, claimantId: CLAIMANT_ID },
        select: { id: true, trackId: true },
      },
    ]);
    expect(manager.findOne.mock.calls[2]).toEqual([
      StudioCopyrightClaim,
      {
        where: { id: CLAIM_ID, claimantId: CLAIMANT_ID },
        lock: { mode: 'pessimistic_write' },
      },
    ]);
  });

  it('answers null for an unknown claim or a claim gone under the lock', async () => {
    manager.findOne.mockResolvedValueOnce(null);
    expect(await lockClaimWithTrackWithin(asManager(), CLAIM_ID)).toBeNull();
    expect(manager.findOne).toHaveBeenCalledTimes(1);

    manager.findOne.mockReset();
    manager.findOne
      .mockResolvedValueOnce({ id: CLAIM_ID, trackId: TRACK_ID })
      .mockResolvedValueOnce({ id: TRACK_ID })
      .mockResolvedValueOnce(null);
    expect(await lockClaimWithTrackWithin(asManager(), CLAIM_ID)).toBeNull();
  });

  it('withholds a track once, keeping the first stamp', async () => {
    await withholdTrackWithin(asManager(), TRACK_ID);
    expect(manager.query).toHaveBeenCalledWith(WITHHOLD_TRACK_SQL, [TRACK_ID]);
    expect(WITHHOLD_TRACK_SQL).toContain('"withheld_at" IS NULL');
  });

  it('restores a track only when no claim on it still holds it', async () => {
    manager.query.mockResolvedValueOnce([{ id: TRACK_ID }]);
    expect(await restoreWithheldTrackWithin(asManager(), TRACK_ID)).toBe(true);
    expect(manager.query).toHaveBeenCalledWith(RESTORE_WITHHELD_TRACK_SQL, [
      TRACK_ID,
    ]);
    expect(RESTORE_WITHHELD_TRACK_SQL).toContain(
      `"holding_claim"."status" IN ('accepted', 'countered', 'upheld')`,
    );
    manager.query.mockResolvedValueOnce([]);
    expect(await restoreWithheldTrackWithin(asManager(), TRACK_ID)).toBe(false);
  });

  it('locks the erased claimant tracks in id order before the restore statement', async () => {
    manager.query
      .mockResolvedValueOnce([{ id: TRACK_ID }])
      .mockResolvedValueOnce([{ id: TRACK_ID }]);
    expect(
      await restoreTracksHeldByClaimantWithin(asManager(), CLAIMANT_ID),
    ).toEqual([TRACK_ID]);
    expect(manager.query.mock.calls).toEqual([
      [LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL, [CLAIMANT_ID]],
      [RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL, [CLAIMANT_ID]],
    ]);
    expect(LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL).toContain(
      'ORDER BY "track"."id"\n FOR UPDATE OF "track"',
    );
    expect(LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL).toContain(
      `"erased_claim"."status" IN ('accepted', 'countered')`,
    );
  });

  it('restores only from accepted or countered claims of the erased claimant', () => {
    expect(RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL).toContain(
      `"erased_claim"."status" IN ('accepted', 'countered')`,
    );
    expect(RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL).not.toContain(
      `"erased_claim"."status" IN ('accepted', 'countered', 'upheld')`,
    );
  });

  // An upheld claim of the erased claimant counts as a withholding claim
  // like any other member's, so our team's decision stands.
  it('counts every other withholding claim, an upheld claim of the erased claimant included', () => {
    expect(RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL).toContain(
      `"other_claim"."status" IN ('accepted', 'countered', 'upheld')`,
    );
    expect(RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL).toContain(
      `AND NOT (
            "other_claim"."claimant_id" = $1
            AND "other_claim"."status" IN ('accepted', 'countered')
          )`,
    );
  });

  it('still runs the restore statement when the lock found no track', async () => {
    expect(
      await restoreTracksHeldByClaimantWithin(asManager(), CLAIMANT_ID),
    ).toEqual([]);
    expect(manager.query).toHaveBeenCalledTimes(2);
  });
});
