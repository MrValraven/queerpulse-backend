import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Community } from './entities/community.entity';

/**
 * How long an owner's sessions have to stay quiet before the community they
 * own is flagged. Overridable with `COMMUNITY_OWNER_INACTIVITY_DAYS`.
 */
const DEFAULT_INACTIVITY_DAYS = 60;

/**
 * The floor a configured cutoff is clamped to. A misconfigured
 * `COMMUNITY_OWNER_INACTIVITY_DAYS=1` would otherwise flag most of the
 * platform on the next midnight tick and drown the admin queue in an outage of
 * our own making, so a value below this is refused and logged rather than
 * honoured. Fourteen days is comfortably longer than any normal holiday and
 * far longer than the refresh-token lifetime, so a genuinely present owner is
 * never inside it.
 */
const MINIMUM_INACTIVITY_DAYS = 14;

/** Communities examined and flagged per pass, so one tick never scans or
 *  locks the whole table at once. */
const FLAG_BATCH_SIZE = 200;

/** Ceiling on batches per tick. 200 x 25 = 5000 communities in one run, and
 *  whatever is left waits for tomorrow rather than pinning the database. */
const FLAG_MAX_BATCHES = 25;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * One community whose owner has gone quiet, as the candidate query returns it.
 * `ownerLastSeenAt` is NULL when the owner has no refresh-token row at all,
 * which counts as inactive (see the class doc comment).
 */
interface InactiveOwnerCandidate {
  communityId: string;
  communitySlug: string;
  ownerUserId: string;
  ownerLastSeenAt: Date | null;
}

/**
 * GOV-02: a daily sweep that stamps `communities.needs_owner_review_at` for
 * every community whose owner has stopped showing up.
 *
 * The two existing routes onto the admin review queue both need something to
 * happen first. `CommunityOwnerOrphanService` needs the owner to actually
 * ERASE their account, and `CommunityOwnerReviewService` needs a member to
 * notice and file. Neither covers the ordinary case: an owner who quietly
 * drifts away, in a room too small or too new for anyone to think of
 * reporting it. This is the automatic route for that case.
 *
 * ## What counts as "gone quiet"
 *
 * There is no `last_seen_at` or `last_active_at` column on `users` or
 * `profiles` in this schema. The only durable per-user activity signal is
 * `refresh_tokens`, so the measure is
 * `MAX(COALESCE(last_seen_at, created_at))` over that user's rows:
 * `last_seen_at` is stamped at sign-in and at every rotation, and `created_at`
 * is the fallback for rows minted before that column existed.
 *
 * The ABSENCE of any row counts as inactive, and the query is written so a
 * NULL aggregate matches rather than being skipped. That is deliberate and it
 * is the safe direction: `AuthMaintenanceService.purgeExpiredRefreshTokens`
 * deletes dead rows one refresh lifetime past expiry (roughly 60 days after
 * the last touch on the default `JWT_REFRESH_TTL=30d`), so a user with no rows
 * left either never signed in or last did so longer ago than the retention
 * window. Skipping NULLs would instead make the sweep quietly stop working for
 * exactly the most-absent owners.
 *
 * The consequence to keep in mind is that the cutoff and the token retention
 * window interact: a cutoff far above retention still behaves correctly (the
 * purged owner is inactive, which is true), while a cutoff far BELOW it is the
 * dangerous direction, which is what `MINIMUM_INACTIVITY_DAYS` exists to
 * bound.
 *
 * ## What it does NOT do
 *
 * It never re-stamps a community that already carries a
 * `needs_owner_review_at`. Clearing that column belongs to the admin surface
 * and to the owner's own "I am still here" withdrawal, and a sweep that
 * re-stamped nightly would make both meaningless. It also skips ownerless
 * communities (`owner_id IS NULL`, already the orphan path's territory) and
 * archived ones (nothing left to govern).
 *
 * ## No governance-log entry, deliberately
 *
 * `GovernanceLogAction` is a Postgres enum. Adding an
 * `owner_inactive_flagged` value needs a migration, and no existing value
 * describes this: `settings_changed` and `owner_auto_promoted` would both be
 * false statements in an audit trail whose only value is being true. So each
 * flagging is written to the application log instead, carrying the owner's
 * last-seen timestamp and the cutoff that fired, and a follow-up migration
 * adding a proper action value is the thing that would move it into
 * `community_governance_log`.
 */
@Injectable()
export class CommunityOwnerInactivityService {
  private readonly logger = new Logger(CommunityOwnerInactivityService.name);

  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    private readonly config: ConfigService,
  ) {}

  /**
   * Daily at midnight. Sixty days is the default measure, so this does not
   * need to run more often than once a day, and midnight is when the
   * refresh-token purge runs too.
   */
  @Cron(CronExpression.EVERY_DAY_AT_MIDNIGHT)
  async flagQuietOwners(): Promise<void> {
    // @nestjs/schedule does not wrap handlers, so a rejection escaping this
    // method becomes an unhandledRejection and takes the process down. A
    // transient database blip must not restart the server; tomorrow's tick
    // picks up whatever this one missed.
    try {
      await this.flagCommunitiesWithQuietOwners();
    } catch (error) {
      this.logger.error(
        `Community owner-inactivity sweep failed: ${
          error instanceof Error
            ? (error.stack ?? error.message)
            : String(error)
        }`,
      );
    }
  }

  /**
   * The sweep itself, separated from the cron wrapper so a backfill or a
   * future test can call it directly without going through the scheduler.
   * Returns how many communities were flagged.
   *
   * Batched rather than one table-wide UPDATE: each pass reads at most
   * `FLAG_BATCH_SIZE` candidates and stamps exactly those ids, and because the
   * candidate query requires `needs_owner_review_at IS NULL` the rows it just
   * stamped cannot come back on the next pass, which is what terminates the
   * loop.
   */
  async flagCommunitiesWithQuietOwners(): Promise<number> {
    const inactivityDays = this.resolveInactivityDays();
    const cutoff = new Date(Date.now() - inactivityDays * MILLISECONDS_PER_DAY);
    let totalFlagged = 0;

    for (let batchIndex = 0; batchIndex < FLAG_MAX_BATCHES; batchIndex += 1) {
      const candidates = await this.loadCandidates(cutoff);
      if (candidates.length === 0) {
        break;
      }

      const stampedAt = new Date();
      const communityIds = candidates.map((candidate) => candidate.communityId);
      // Re-assert `needs_owner_review_at IS NULL` in the UPDATE itself: the
      // candidate read and this write are two statements, and a member filing
      // an owner review (or an admin clearing one) in between must not have
      // their stamp overwritten by this sweep's timestamp.
      const updateResult = await this.communities
        .createQueryBuilder()
        .update(Community)
        .set({ needsOwnerReviewAt: stampedAt })
        .where('id IN (:...communityIds)', { communityIds })
        .andWhere('needs_owner_review_at IS NULL')
        .execute();
      totalFlagged += updateResult.affected ?? 0;

      for (const candidate of candidates) {
        // Stands in for the governance-log entry this cannot write. See the
        // class doc comment: the enum value it would need does not exist and
        // adding one requires a migration.
        this.logger.warn(
          `Community ${candidate.communitySlug} (${candidate.communityId}) flagged for owner review: ` +
            `owner ${candidate.ownerUserId} last seen ` +
            `${candidate.ownerLastSeenAt ? candidate.ownerLastSeenAt.toISOString() : 'never (no session on record)'}, ` +
            `cutoff ${cutoff.toISOString()} (${inactivityDays} days)`,
        );
      }

      if (candidates.length < FLAG_BATCH_SIZE) {
        break;
      }
    }

    if (totalFlagged > 0) {
      this.logger.log(
        `Owner-inactivity sweep flagged ${totalFlagged} community row(s) whose owner has not been seen since ${cutoff.toISOString()}`,
      );
    }
    return totalFlagged;
  }

  /**
   * One bounded page of communities whose owner's last session touch is older
   * than `cutoff`, or who has no session on record at all.
   *
   * Raw SQL because the per-owner aggregate is a correlated
   * `MAX(COALESCE(last_seen_at, created_at))` over `refresh_tokens`, which
   * belongs to another module's entity and which the query builder cannot
   * express as a lateral join without registering that entity here. The
   * lateral is `LEFT JOIN LATERAL ... ON TRUE` so a community whose owner has
   * NO token rows still produces a row, with a NULL aggregate, and the
   * `IS NULL OR < cutoff` predicate is what makes that count as inactive.
   * Every value is bound as a parameter; nothing is interpolated.
   *
   * `refresh_tokens.user_id` is indexed (`IDX_refresh_tokens_user_id`), so the
   * lateral is an index lookup per candidate rather than a scan.
   */
  private async loadCandidates(
    cutoff: Date,
  ): Promise<InactiveOwnerCandidate[]> {
    return this.communities.query<InactiveOwnerCandidate[]>(
      `SELECT candidate.id AS "communityId",
              candidate.slug AS "communitySlug",
              candidate.owner_id AS "ownerUserId",
              owner_session.last_touch_at AS "ownerLastSeenAt"
         FROM communities candidate
         LEFT JOIN LATERAL (
           SELECT MAX(COALESCE(token.last_seen_at, token.created_at))
                    AS last_touch_at
             FROM refresh_tokens token
            WHERE token.user_id = candidate.owner_id
         ) owner_session ON TRUE
        WHERE candidate.needs_owner_review_at IS NULL
          AND candidate.owner_id IS NOT NULL
          AND candidate.archived_at IS NULL
          AND (owner_session.last_touch_at IS NULL
               OR owner_session.last_touch_at < $1)
        ORDER BY candidate.id
        LIMIT $2`,
      [cutoff, FLAG_BATCH_SIZE],
    );
  }

  /**
   * The configured inactivity window in days, clamped.
   *
   * Read straight off `COMMUNITY_OWNER_INACTIVITY_DAYS` through
   * `ConfigService`, the shape `StorageMaintenanceService` uses for its own
   * sweep knobs, rather than being added to the typed config namespaces. An
   * unset, unparseable or non-positive value falls back to the default; a
   * positive value below `MINIMUM_INACTIVITY_DAYS` is raised to that floor and
   * logged, because silently honouring a `1` here would flag most of the
   * platform overnight.
   */
  private resolveInactivityDays(): number {
    const configuredValue = this.config.get<string>(
      'COMMUNITY_OWNER_INACTIVITY_DAYS',
    );
    const configuredDays = Number(configuredValue);
    if (!Number.isFinite(configuredDays) || configuredDays <= 0) {
      return DEFAULT_INACTIVITY_DAYS;
    }
    if (configuredDays < MINIMUM_INACTIVITY_DAYS) {
      this.logger.warn(
        `COMMUNITY_OWNER_INACTIVITY_DAYS=${configuredDays} is below the ${MINIMUM_INACTIVITY_DAYS}-day floor and was clamped to it. ` +
          'A shorter window would flag communities whose owners are merely away rather than gone.',
      );
      return MINIMUM_INACTIVITY_DAYS;
    }
    return configuredDays;
  }
}
