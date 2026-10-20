import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { isUniqueViolation } from '../common/db-errors';
import { CreateStudioClaimDto } from './dto/create-studio-claim.dto';
import {
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { StudioTrack } from './entities/studio-track.entity';
import {
  StudioMyClaim,
  StudioOwnerClaim,
  toStudioMyClaim,
  toStudioOwnerClaim,
} from './studio-claim-response';
import {
  LIVE_CLAIM_STATUSES,
  assertCounterAllowed,
  assertReplyAllowed,
  assertWithdrawAllowed,
  isHoldingClaimStatus,
  isOwnerVisibleClaimStatus,
} from './studio-claim-rule';
import {
  lockClaimWithTrackWithin,
  restoreWithheldTrackWithin,
} from './studio-claim-store';
import { decodeStudioCursor } from './studio-cursor';
import { notBlockedEitherWaySql } from './studio-discovery-sql';
import { toKeysetPage } from './studio-keyset-page';
import { releasedTrackAudioSql } from './studio-playlist-visibility';
import { StudioPage } from './studio-response';
import {
  STUDIO_CLAIM_LIMITS,
  studioSafetyError,
} from './studio-safety.constants';
import { StudioSafetyNoticesService } from './studio-safety-notices.service';
import { listenablePersonaSql } from './studio-visibility';

/** The length of both name columns kept at filing (a track title and a
 *  persona name are 120 at most). */
const CLAIM_SNAPSHOT_NAME_MAX = 120;

interface FileableTrackRow {
  release_id: string;
  artist_name: string;
  is_owner: boolean;
}

/**
 * `$1` the track. Locks the track's release row FOR KEY SHARE, the lock the
 * claim insert's foreign key takes anyway, so filing holds the release
 * before the track like every other write that locks both (LOCK ORDER in
 * `studio-claim-store.ts`). Answers the release id, or no row.
 */
export const LOCK_RELEASE_OF_TRACK_SQL = `SELECT "release"."id" AS "id"
  FROM "studio_releases" "release"
 WHERE "release"."id" = (
   SELECT "track"."release_id" FROM "studio_tracks" "track" WHERE "track"."id" = $1
 )
 FOR KEY SHARE OF "release"`;

/**
 * `$1` the track, `$2` the claimant. A track the claimant can hear right
 * now, withheld or not (a second rights holder may file while another
 * claim holds it): published release, audio in place, a published episode,
 * a listenable persona, no block either way with its creator. `is_owner`
 * says whether the claimant is the persona's creator or a co-owner;
 * `artist_name` is the persona name the claim keeps from its filing.
 */
export const FILEABLE_TRACK_SQL = `SELECT "track"."release_id" AS "release_id",
       "persona"."display_name" AS "artist_name",
       ("persona"."user_id" = $2 OR EXISTS (
          SELECT 1 FROM "subprofile_members" "track_owner"
           WHERE "track_owner"."subprofile_id" = "persona"."id"
             AND "track_owner"."user_id" = $2
       )) AS "is_owner"
  FROM "studio_tracks" "track"
 INNER JOIN "studio_releases" "release" ON "release"."id" = "track"."release_id"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "track"."id" = $1
   AND ${releasedTrackAudioSql('track', 'release')}
   AND ${listenablePersonaSql('persona')}
   AND ${notBlockedEitherWaySql('$2', '"persona"."user_id"', 'claim_block')}`;

/** `$1` the release, `$2` the member: a row when the member is the
 *  persona's creator or a co-owner. Checked at call time, stored nowhere. */
export const RELEASE_OWNER_SQL = `SELECT 1 AS "is_owner"
  FROM "studio_releases" "release"
 INNER JOIN "subprofiles" "persona" ON "persona"."id" = "release"."subprofile_id"
 WHERE "release"."id" = $1
   AND ("persona"."user_id" = $2 OR EXISTS (
     SELECT 1 FROM "subprofile_members" "release_owner"
      WHERE "release_owner"."subprofile_id" = "persona"."id"
        AND "release_owner"."user_id" = $2
   ))`;

/**
 * Studio safety and moderation (spec 5.2): the claimant's side (file, list,
 * reply, withdraw) and the owner's counter-notice.
 *
 * Every write locks the track row, then the claim row
 * (`lockClaimWithTrackWithin`), and checks its transition under the lock
 * (`studio-claim-rule.ts`). Filing inserts a claim, so it locks the release
 * row first and the track row second. Notices go out after commit.
 *
 * NO ARTIST MEMBER IS STORED. The counter checks that the caller runs the
 * persona (`RELEASE_OWNER_SQL`) and writes the note only. A counter on a
 * claim the owner may not see (submitted, declined, or withdrawn at any
 * stage) answers the same 404 as an unknown id, so the route never
 * confirms that a submitted claim exists.
 *
 * A claim keeps the track title and artist name from its filing. Once a
 * persona unlink severs it (`isSevered`), the claimant view serves those
 * names with no track, release or persona reference.
 */
@Injectable()
export class StudioClaimsService {
  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(StudioCopyrightClaim)
    private readonly claims: Repository<StudioCopyrightClaim>,
    private readonly notices: StudioSafetyNoticesService,
  ) {}

  /** Refusals in order: 404, own track, a live claim already, the cap. */
  async file(
    claimantId: string,
    trackId: string,
    body: CreateStudioClaimDto,
  ): Promise<StudioMyClaim> {
    const claimId = await this.dataSource.transaction(async (manager) => {
      // LOCK ORDER: the release row, then the track row. A track PATCH, an
      // audio confirm and an episode publish lock release then track, and
      // the claim insert below needs a key share on the release.
      const [lockedRelease]: { id: string }[] = await manager.query(
        LOCK_RELEASE_OF_TRACK_SQL,
        [trackId],
      );
      if (!lockedRelease) {
        throw new NotFoundException('Track not found');
      }
      const track = await manager.findOne(StudioTrack, {
        where: { id: trackId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!track || track.releaseId !== lockedRelease.id) {
        throw new NotFoundException('Track not found');
      }
      const [fileableTrack]: FileableTrackRow[] = await manager.query(
        FILEABLE_TRACK_SQL,
        [track.id, claimantId],
      );
      if (!fileableTrack) {
        throw new NotFoundException('Track not found');
      }
      if (fileableTrack.is_owner) {
        throw studioSafetyError('studio_claim_own_track');
      }
      const hasLiveClaim = await manager.exists(StudioCopyrightClaim, {
        where: {
          trackId: track.id,
          claimantId,
          status: In([...LIVE_CLAIM_STATUSES]),
        },
      });
      if (hasLiveClaim) {
        throw studioSafetyError('studio_claim_exists');
      }
      const liveClaimCount = await manager.count(StudioCopyrightClaim, {
        where: { claimantId, status: In([...LIVE_CLAIM_STATUSES]) },
      });
      if (liveClaimCount >= STUDIO_CLAIM_LIMITS.liveClaimsPerClaimant) {
        throw studioSafetyError('studio_claim_limit');
      }
      try {
        const inserted = await manager.insert(StudioCopyrightClaim, {
          trackId: track.id,
          releaseId: track.releaseId,
          claimantId,
          claimantRole: body.claimantRole,
          originalWork: body.originalWork,
          originalLink: body.originalLink ?? null,
          details: body.details,
          goodFaithAt: new Date(),
          status: StudioCopyrightClaimStatus.Submitted,
          trackTitleAtFiling: track.title,
          artistNameAtFiling: fileableTrack.artist_name.slice(
            0,
            CLAIM_SNAPSHOT_NAME_MAX,
          ),
        });
        return (inserted.identifiers[0] as { id: string }).id;
      } catch (error) {
        // The track lock makes this rare; the partial unique index is the
        // last word for two filings by one member.
        if (
          isUniqueViolation(
            error,
            'UQ_studio_copyright_claims_live_track_claimant',
          )
        ) {
          throw studioSafetyError('studio_claim_exists');
        }
        throw error;
      }
    });
    return this.myClaim(claimantId, claimId);
  }

  /** The claimant's claims, newest first, 20 a page. */
  async listMine(
    claimantId: string,
    cursor: string | undefined,
  ): Promise<StudioPage<StudioMyClaim>> {
    const pageSize = STUDIO_CLAIM_LIMITS.pageSize;
    const queryBuilder = this.claims
      .createQueryBuilder('claim')
      .leftJoinAndSelect('claim.track', 'track')
      .leftJoinAndSelect('claim.release', 'release')
      .leftJoinAndSelect('release.subprofile', 'persona')
      .where('claim.claimantId = :claimantId', { claimantId });
    const decodedCursor = decodeStudioCursor(cursor);
    if (decodedCursor) {
      queryBuilder.andWhere(
        '("claim"."created_at", "claim"."id") < (:cursorCreatedAt, :cursorId)',
        {
          cursorCreatedAt: decodedCursor.publishedAt,
          cursorId: decodedCursor.id,
        },
      );
    }
    // Every join is many-to-one, so `limit` never cuts a row set.
    const rows = await queryBuilder
      .orderBy('claim.createdAt', 'DESC')
      .addOrderBy('claim.id', 'DESC')
      .limit(pageSize + 1)
      .getMany();
    return toKeysetPage(
      rows,
      pageSize,
      (claim) => ({ publishedAt: claim.createdAt, id: claim.id }),
      (pageRows) =>
        Promise.resolve(
          pageRows.flatMap((claim) => this.toMyClaimOrNothing(claim)),
        ),
    );
  }

  async reply(
    claimantId: string,
    claimId: string,
    reply: string,
  ): Promise<StudioMyClaim> {
    await this.dataSource.transaction(async (manager) => {
      const locked = await lockClaimWithTrackWithin(
        manager,
        claimId,
        claimantId,
      );
      if (!locked) {
        throw new NotFoundException('Claim not found');
      }
      assertReplyAllowed(locked.claim);
      locked.claim.claimantReply = reply;
      locked.claim.repliedAt = new Date();
      await manager.save(locked.claim);
    });
    return this.myClaim(claimantId, claimId);
  }

  /** A held claim restores its track (when nothing else withholds it) and
   *  tells the owners after commit; a submitted claim goes silently. */
  async withdraw(claimantId: string, claimId: string): Promise<StudioMyClaim> {
    const heldTrackId = await this.dataSource.transaction(async (manager) => {
      const locked = await lockClaimWithTrackWithin(
        manager,
        claimId,
        claimantId,
      );
      if (!locked) {
        throw new NotFoundException('Claim not found');
      }
      assertWithdrawAllowed(locked.claim);
      const wasHolding = isHoldingClaimStatus(locked.claim.status);
      locked.claim.status = StudioCopyrightClaimStatus.Withdrawn;
      await manager.save(locked.claim);
      if (!wasHolding) {
        return null;
      }
      await restoreWithheldTrackWithin(manager, locked.track.id);
      return locked.track.id;
    });
    if (heldTrackId) {
      await this.notices.claimWithdrawn(claimId, heldTrackId);
    }
    return this.myClaim(claimantId, claimId);
  }

  /** The owner's one counter-notice, while the claim is accepted. Allowed
   *  for restricted members, like a dispute. */
  async counter(
    userId: string,
    claimId: string,
    note: string,
  ): Promise<StudioOwnerClaim> {
    const located = await this.claims.findOne({
      where: { id: claimId },
      select: { id: true, releaseId: true, status: true },
    });
    if (
      !located ||
      !isOwnerVisibleClaimStatus(located.status) ||
      !(await this.isReleaseOwner(userId, located.releaseId))
    ) {
      throw new NotFoundException('Claim not found');
    }
    const counteredClaim = await this.dataSource.transaction(
      async (manager) => {
        const locked = await lockClaimWithTrackWithin(manager, claimId);
        if (!locked || !isOwnerVisibleClaimStatus(locked.claim.status)) {
          throw new NotFoundException('Claim not found');
        }
        assertCounterAllowed(locked.claim);
        locked.claim.counterNote = note;
        locked.claim.counteredAt = new Date();
        locked.claim.status = StudioCopyrightClaimStatus.Countered;
        return manager.save(locked.claim);
      },
    );
    await this.notices.claimCountered(
      claimId,
      counteredClaim.claimantId,
      counteredClaim.trackId,
    );
    return toStudioOwnerClaim(counteredClaim);
  }

  private async isReleaseOwner(
    userId: string,
    releaseId: string,
  ): Promise<boolean> {
    const rows: unknown[] = await this.dataSource.query(RELEASE_OWNER_SQL, [
      releaseId,
      userId,
    ]);
    return rows.length > 0;
  }

  private async myClaim(
    claimantId: string,
    claimId: string,
  ): Promise<StudioMyClaim> {
    const claim = await this.claims.findOne({
      where: { id: claimId, claimantId },
      relations: { track: true, release: { subprofile: true } },
    });
    const [myClaim] = claim ? this.toMyClaimOrNothing(claim) : [];
    if (!myClaim) {
      throw new NotFoundException('Claim not found');
    }
    return myClaim;
  }

  // A severed claim answers from the names kept at filing and reads none of
  // its joins. Any other claim whose track or release went drops out; the
  // cascade removes it in the same commit, so this only covers a read
  // racing that delete.
  private toMyClaimOrNothing(claim: StudioCopyrightClaim): StudioMyClaim[] {
    if (claim.isSevered) {
      return [toStudioMyClaim(claim, null)];
    }
    const persona = claim.release?.subprofile;
    return claim.track && claim.release && persona
      ? [
          toStudioMyClaim(claim, {
            track: claim.track,
            release: claim.release,
            persona,
          }),
        ]
      : [];
  }
}
