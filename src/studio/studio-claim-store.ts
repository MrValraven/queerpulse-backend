import { EntityManager, In } from 'typeorm';
import { StudioCopyrightClaim } from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import { StudioOwnerClaim, toStudioOwnerClaim } from './studio-claim-response';
import { OWNER_VISIBLE_CLAIM_STATUSES } from './studio-claim-rule';
import {
  STUDIO_CLAIM_HOLDING_LIST_SQL,
  STUDIO_CLAIM_WITHHOLDING_LIST_SQL,
} from './studio-safety.constants';

/*
 * Studio safety and moderation: the row work every claim path shares, kept
 * in one place so the lock order and the restore rule are spelled once.
 * Every function takes the caller's transaction `manager`.
 *
 * LOCK ORDER: the release row before the track row for any write that
 * inserts a claim (the insert's foreign key takes a key share on the
 * release, and a track PATCH, an audio confirm and an episode publish lock
 * release then track), then the track row, then the claim row. The
 * claimant, owner and staff writes all take it, so two writes on one claim
 * (or two claims on one track) run one at a time and never deadlock. The
 * account erasure locks every track it may restore, in id order, before
 * its restore statement.
 *
 * RESTORE RULE (spec 5.1): a track's `withheld_at` clears only when no claim
 * on it is `accepted` or `countered`, and (plan decision, the spec's "upheld:
 * the track stays withheld") none is `upheld`. A caller saves the claim's new
 * status first, so the claim it just closed no longer counts.
 */

/** Owner-visible claims on these tracks, newest accepted first. Owners
 *  only: the caller has already checked that the viewer runs the persona. */
export async function ownerClaimsForTracks(
  manager: EntityManager,
  trackIds: readonly string[],
): Promise<StudioOwnerClaim[]> {
  if (!trackIds.length) {
    return [];
  }
  const claims = await manager.find(StudioCopyrightClaim, {
    where: {
      trackId: In([...trackIds]),
      status: In([...OWNER_VISIBLE_CLAIM_STATUSES]),
    },
    order: { acceptedAt: 'DESC', id: 'DESC' },
  });
  return claims.map(toStudioOwnerClaim);
}

export interface LockedClaim {
  claim: StudioCopyrightClaim;
  track: StudioTrack;
}

/**
 * Reads the claim's track id, locks the track row, then locks and re-reads
 * the claim. With `claimantId`, a claim filed by someone else reads as
 * missing. Null when the claim (or its track) is gone.
 */
export async function lockClaimWithTrackWithin(
  manager: EntityManager,
  claimId: string,
  claimantId?: string,
): Promise<LockedClaim | null> {
  const where = claimantId ? { id: claimId, claimantId } : { id: claimId };
  const located = await manager.findOne(StudioCopyrightClaim, {
    where,
    select: { id: true, trackId: true },
  });
  if (!located) {
    return null;
  }
  const track = await manager.findOne(StudioTrack, {
    where: { id: located.trackId },
    lock: { mode: 'pessimistic_write' },
  });
  const claim = await manager.findOne(StudioCopyrightClaim, {
    where,
    lock: { mode: 'pessimistic_write' },
  });
  if (!track || !claim) {
    return null;
  }
  return { claim, track };
}

/** Accept: the track goes offline, keeping an earlier stamp when another
 *  claim already holds it. */
export const WITHHOLD_TRACK_SQL = `UPDATE "studio_tracks" SET "withheld_at" = now()
 WHERE "id" = $1 AND "withheld_at" IS NULL`;

/** Precondition: the caller holds the track row lock
 *  (`lockClaimWithTrackWithin`) and has saved the claim's new status. */
export async function withholdTrackWithin(
  manager: EntityManager,
  trackId: string,
): Promise<void> {
  await manager.query(WITHHOLD_TRACK_SQL, [trackId]);
}

/** The restore rule for one track. Returns the track id when it came back. */
export const RESTORE_WITHHELD_TRACK_SQL = `WITH "restored" AS (
  UPDATE "studio_tracks" SET "withheld_at" = NULL
   WHERE "id" = $1
     AND "withheld_at" IS NOT NULL
     AND NOT EXISTS (
       SELECT 1 FROM "studio_copyright_claims" "holding_claim"
        WHERE "holding_claim"."track_id" = $1
          AND "holding_claim"."status" IN (${STUDIO_CLAIM_WITHHOLDING_LIST_SQL})
     )
  RETURNING "id"
)
SELECT "id" FROM "restored"`;

/** Precondition: the caller holds the track row lock
 *  (`lockClaimWithTrackWithin`) and has saved the claim's new status, so
 *  the NOT EXISTS check reads every claim on the track as committed. */
export async function restoreWithheldTrackWithin(
  manager: EntityManager,
  trackId: string,
): Promise<boolean> {
  const rows: { id: string }[] = await manager.query(
    RESTORE_WITHHELD_TRACK_SQL,
    [trackId],
  );
  return rows.length > 0;
}

/**
 * `$1` the erased claimant. Locks every track one of their accepted or
 * countered claims names, in id order, so the restore below runs with no
 * claim write in flight on those tracks (every claim write locks the track
 * row first). The restore is a separate statement: a single UPDATE that
 * waits on a row lock re-checks only that row, and its NOT EXISTS would
 * still read the snapshot taken before the wait.
 */
export const LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL = `SELECT "track"."id" AS "id"
  FROM "studio_tracks" "track"
 WHERE "track"."id" IN (
   SELECT "erased_claim"."track_id" FROM "studio_copyright_claims" "erased_claim"
    WHERE "erased_claim"."claimant_id" = $1
      AND "erased_claim"."status" IN (${STUDIO_CLAIM_HOLDING_LIST_SQL})
 )
 ORDER BY "track"."id"
 FOR UPDATE OF "track"`;

/**
 * The account erasure's restore: a track one of this member's accepted or
 * countered claims keeps offline comes back when no other withholding claim
 * remains on it. A track their own upheld claim holds stays offline: our
 * team's decision stands after the claimant goes. Runs after
 * `LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL`, before the user row goes, while
 * `claimant_id` names them; the cascade then removes their claims.
 */
export const RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL = `WITH "restored" AS (
  UPDATE "studio_tracks" AS "track" SET "withheld_at" = NULL
   WHERE "track"."withheld_at" IS NOT NULL
     AND "track"."id" IN (
       SELECT "erased_claim"."track_id" FROM "studio_copyright_claims" "erased_claim"
        WHERE "erased_claim"."claimant_id" = $1
          AND "erased_claim"."status" IN (${STUDIO_CLAIM_HOLDING_LIST_SQL})
     )
     AND NOT EXISTS (
       SELECT 1 FROM "studio_copyright_claims" "other_claim"
        WHERE "other_claim"."track_id" = "track"."id"
          AND "other_claim"."status" IN (${STUDIO_CLAIM_WITHHOLDING_LIST_SQL})
          AND NOT (
            "other_claim"."claimant_id" = $1
            AND "other_claim"."status" IN (${STUDIO_CLAIM_HOLDING_LIST_SQL})
          )
     )
  RETURNING "track"."id" AS "id"
)
SELECT "id" FROM "restored"`;

/** Locks, then restores. The restore runs even when the lock found no
 *  track, so it stays one cheap set-based statement on every erasure. */
export async function restoreTracksHeldByClaimantWithin(
  manager: EntityManager,
  claimantId: string,
): Promise<string[]> {
  await manager.query(LOCK_TRACKS_OF_ERASED_CLAIMANT_SQL, [claimantId]);
  const rows: { id: string }[] = await manager.query(
    RESTORE_TRACKS_OF_ERASED_CLAIMANT_SQL,
    [claimantId],
  );
  return rows.map((row) => row.id);
}
