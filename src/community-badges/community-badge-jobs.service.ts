import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource, type EntityManager } from 'typeorm';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';

/**
 * Postgres advisory-lock key for the per-minute silent backfill. Advisory
 * locks share one global namespace; this is the next free key after the
 * Studio purchase expiry (793_640_008_000).
 */
export const COMMUNITY_BADGE_BACKFILL_LOCK_KEY = 793_640_009_000;

/**
 * Postgres advisory-lock key for the daily badge sweep, the key after
 * `COMMUNITY_BADGE_BACKFILL_LOCK_KEY` in the same global namespace.
 */
export const COMMUNITY_BADGE_SWEEP_LOCK_KEY = 793_640_009_001;

/** Badges one backfill tick claims; the rest wait for the next minute. */
export const BACKFILL_BADGES_PER_TICK = 100;

/** Communities one keyset page of the daily sweep reads. */
export const SWEEP_COMMUNITIES_PER_PAGE = 200;

/** The id the first sweep page starts after, below every uuid. */
export const SWEEP_FIRST_PAGE_AFTER_ID = '00000000-0000-0000-0000-000000000000';

/**
 * Claims up to 100 badges with a pending backfill, oldest request first,
 * skipping rows another transaction holds. `FOR NO KEY UPDATE` still blocks a
 * staff edit of the claimed badge until commit, and lets award inserts and
 * worn badge writes that reference the badge through a foreign key go ahead.
 * Parameters: none.
 */
export const CLAIM_BACKFILL_BATCH_SQL = `SELECT "id", "community_id" FROM "community_badges"
  WHERE "backfill_requested_at" IS NOT NULL
  ORDER BY "backfill_requested_at", "id"
  LIMIT ${BACKFILL_BADGES_PER_TICK}
  FOR NO KEY UPDATE SKIP LOCKED`;

/**
 * Clears the backfill flag of the given badges. Parameters: `[badgeIds]`.
 * Safe against a newer request: the claim's row locks last until this
 * transaction commits, so a staff edit that sets the flag again during the
 * tick waits and writes its flag after this clear.
 */
export const CLEAR_BACKFILL_SQL = `UPDATE "community_badges" SET "backfill_requested_at" = NULL WHERE "id" = ANY($1::uuid[])`;

/**
 * One keyset page of live top-level communities that hold at least one
 * enabled badge with no pending backfill. Parameters: `[afterCommunityId]`.
 */
export const SWEEP_COMMUNITIES_PAGE_SQL = `SELECT "c"."id" FROM "communities" "c"
  WHERE "c"."parent_id" IS NULL
    AND "c"."archived_at" IS NULL
    AND "c"."id" > $1
    AND EXISTS (
      SELECT 1 FROM "community_badges" "b"
       WHERE "b"."community_id" = "c"."id"
         AND "b"."is_enabled"
         AND "b"."backfill_requested_at" IS NULL
    )
  ORDER BY "c"."id"
  LIMIT ${SWEEP_COMMUNITIES_PER_PAGE}`;

/** Savepoint that isolates one community inside the backfill transaction. */
export const BACKFILL_COMMUNITY_SAVEPOINT_SQL =
  'SAVEPOINT "community_badge_backfill"';

/** Releases the per-community savepoint after a successful award. */
export const RELEASE_BACKFILL_COMMUNITY_SAVEPOINT_SQL =
  'RELEASE SAVEPOINT "community_badge_backfill"';

/** Undoes one failed community and keeps the transaction usable. */
export const ROLLBACK_BACKFILL_COMMUNITY_SAVEPOINT_SQL =
  'ROLLBACK TO SAVEPOINT "community_badge_backfill"';

/** A claimed badge row as `CLAIM_BACKFILL_BATCH_SQL` returns it. */
interface ClaimedBackfillRow {
  id: string;
  community_id: string;
}

/** A community row as `SWEEP_COMMUNITIES_PAGE_SQL` returns it. */
interface SweepCommunityRow {
  id: string;
}

/** The error class name, so a log line carries no message text or ids. */
function errorClassName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : typeof error;
}

/**
 * Community badges: the two scheduled award runs. The per-minute backfill
 * awards history for badges flagged by seeding, create, enable or a lowered
 * threshold, silently and inside one transaction, then clears their flags.
 * The daily sweep awards every live top-level community its ready badges and
 * notifies the new holders. `@Cron` fires in every replica, so each run holds
 * a session-level `pg_try_advisory_lock` on its own `QueryRunner` and unlocks
 * on that same connection (the `StudioPurchaseExpiryService` pattern). One
 * community's failure is logged with its error class and the run goes on;
 * log lines carry counts only.
 */
@Injectable()
export class CommunityBadgeJobsService {
  private readonly logger = new Logger(CommunityBadgeJobsService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly awarding: CommunityBadgeAwardingService,
  ) {}

  /**
   * Silent backfill tick: claims a batch of flagged badges, awards each
   * community's claimed badges on the transaction manager (silent, since the
   * bell write cannot join this transaction), then clears the flags of every
   * badge whose community succeeded. A disabled badge is cleared with no
   * award, since the award SQL reads enabled badges only.
   */
  @Cron(CronExpression.EVERY_MINUTE)
  async runBackfill(): Promise<void> {
    await this.underLock(COMMUNITY_BADGE_BACKFILL_LOCK_KEY, 'backfill', () =>
      this.backfillOnce(),
    );
  }

  /**
   * Daily sweep: keyset pages of live top-level communities, awarding each
   * its ready badges with notifications on. Runs on the pool with no manager,
   * so the bell write is allowed.
   */
  @Cron(CronExpression.EVERY_DAY_AT_5AM)
  async runDailySweep(): Promise<void> {
    await this.underLock(COMMUNITY_BADGE_SWEEP_LOCK_KEY, 'sweep', () =>
      this.sweepOnce(),
    );
  }

  /** One backfill transaction; logs the number of cleared badges. */
  private async backfillOnce(): Promise<void> {
    const clearedCount = await this.dataSource.transaction(async (manager) => {
      const claimedRows: ClaimedBackfillRow[] = await manager.query(
        CLAIM_BACKFILL_BATCH_SQL,
      );
      if (!claimedRows.length) {
        return 0;
      }
      const badgeIdsByCommunityId = new Map<string, string[]>();
      for (const row of claimedRows) {
        const badgeIds = badgeIdsByCommunityId.get(row.community_id) ?? [];
        badgeIds.push(row.id);
        badgeIdsByCommunityId.set(row.community_id, badgeIds);
      }
      const clearedBadgeIds: string[] = [];
      for (const [communityId, badgeIds] of badgeIdsByCommunityId) {
        const hasAwarded = await this.backfillCommunity(
          manager,
          communityId,
          badgeIds,
        );
        if (hasAwarded) {
          clearedBadgeIds.push(...badgeIds);
        }
      }
      if (clearedBadgeIds.length) {
        await manager.query(CLEAR_BACKFILL_SQL, [clearedBadgeIds]);
      }
      return clearedBadgeIds.length;
    });
    if (clearedCount > 0) {
      this.logger.log(`Backfilled ${clearedCount} community badges`);
    }
  }

  /**
   * Awards one community's claimed badges behind a savepoint. A failure rolls
   * back to the savepoint, is logged with its error class and leaves the
   * flags set for the next tick. Returns whether the award succeeded.
   */
  private async backfillCommunity(
    manager: EntityManager,
    communityId: string,
    badgeIds: string[],
  ): Promise<boolean> {
    await manager.query(BACKFILL_COMMUNITY_SAVEPOINT_SQL);
    try {
      await this.awarding.awardCommunity(
        {
          communityId,
          badgeIds,
          shouldNotify: false,
          onlyReadyBadges: false,
        },
        manager,
      );
      await manager.query(RELEASE_BACKFILL_COMMUNITY_SAVEPOINT_SQL);
      return true;
    } catch (error) {
      await manager.query(ROLLBACK_BACKFILL_COMMUNITY_SAVEPOINT_SQL);
      this.logger.warn(
        `Community badge backfill failed for one community: ${errorClassName(error)}`,
      );
      return false;
    }
  }

  /** Every sweep page in id order; logs the community and award counts. */
  private async sweepOnce(): Promise<void> {
    let afterCommunityId = SWEEP_FIRST_PAGE_AFTER_ID;
    let sweptCount = 0;
    let awardedCount = 0;
    let failedCount = 0;
    let pageSize = SWEEP_COMMUNITIES_PER_PAGE;
    while (pageSize >= SWEEP_COMMUNITIES_PER_PAGE) {
      const pageRows: SweepCommunityRow[] = await this.dataSource.query(
        SWEEP_COMMUNITIES_PAGE_SQL,
        [afterCommunityId],
      );
      pageSize = pageRows.length;
      for (const row of pageRows) {
        try {
          awardedCount += await this.awarding.awardCommunity({
            communityId: row.id,
            badgeIds: null,
            shouldNotify: true,
            onlyReadyBadges: true,
          });
          sweptCount += 1;
        } catch (error) {
          failedCount += 1;
          this.logger.warn(
            `Community badge sweep failed for one community: ${errorClassName(error)}`,
          );
        }
      }
      const lastRow = pageRows[pageRows.length - 1];
      if (lastRow) {
        afterCommunityId = lastRow.id;
      }
    }
    this.logger.log(
      `Community badge sweep: ${sweptCount} communities, ${awardedCount} awards, ${failedCount} failed`,
    );
  }

  /**
   * Runs `work` while holding a session-level advisory lock on a dedicated
   * connection. Skips quietly when another replica holds the lock. Every
   * failure is logged with its error class; the scheduler sees none.
   */
  private async underLock(
    lockKey: number,
    jobName: string,
    work: () => Promise<void>,
  ): Promise<void> {
    const lockRunner = this.dataSource.createQueryRunner();
    let hasLock = false;
    try {
      await lockRunner.connect();
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [lockKey],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          `Community badge ${jobName} skipped: another process holds the lock`,
        );
        return;
      }
      hasLock = true;
      await work();
    } catch (error) {
      this.logger.warn(
        `Community badge ${jobName} failed: ${errorClassName(error)}`,
      );
    } finally {
      try {
        if (hasLock) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [lockKey]);
        }
      } catch (error) {
        this.logger.warn(
          `Community badge ${jobName} unlock failed: ${errorClassName(error)}`,
        );
      } finally {
        await lockRunner.release().catch((error: unknown) => {
          this.logger.warn(
            `Community badge ${jobName} connection release failed: ${errorClassName(error)}`,
          );
        });
      }
    }
  }
}
