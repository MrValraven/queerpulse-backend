import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import {
  STUDIO_RELEASE_PUBLISHED,
  StudioReleasePublishedEvent,
} from './studio.events';
import { STUDIO_LIMITS } from './studio.constants';

/**
 * Postgres advisory-lock key for the scheduled drop. Advisory locks share
 * ONE global namespace, so this differs from every other key in `src/`: the
 * cinema reconciliation (793640001), the identity mailbox reconciliation
 * (793_640_002_000), Go together's matching and retention runs
 * (793_640_003_000 / 793_640_003_001), the persona feed sweep
 * (793_640_004_000), the purchase expiry (793_640_008_000) and the migration
 * lock (481_205_733_107_400).
 */
export const SCHEDULED_RELEASES_LOCK_KEY = 793_640_005_000;

/**
 * Publishes due scheduled releases in one statement: picks at most $1 of
 * them, oldest time first, skipping rows another transaction holds (an
 * owner unscheduling at the same moment), and copies `publish_at` into
 * `published_at`, so a drop that missed its minute keeps its intended time.
 * An empty release date gets the Lisbon date of `publish_at` (every SET
 * expression reads the row as it was, so this sees the old `publish_at`).
 * A taken-down release has no `publish_at` (the takedown clears it), so it
 * is never picked. Wrapped in `WITH ... SELECT` so `DataSource.query`
 * returns plain rows. Studio artist kinds: a podcast show's episodes with
 * confirmed audio and no publish time take the release's new
 * `published_at` and their alert claim in the same statement (a
 * data-modifying CTE runs to completion whether or not the final SELECT
 * reads it), so the release alert covers them and the episode alert finds
 * nothing. `STAMP_SHOW_EPISODES_SQL` is the same stamp for a publish now.
 */
export const SCHEDULED_RELEASE_CLAIM_SQL = `WITH "due" AS (
  SELECT "id" FROM "studio_releases"
   WHERE "status" = 'scheduled' AND "publish_at" <= now()
   ORDER BY "publish_at" ASC, "id" ASC
   LIMIT $1
   FOR UPDATE SKIP LOCKED
), "published" AS (
  UPDATE "studio_releases" AS "release"
     SET "status" = 'published',
         "published_at" = "release"."publish_at",
         "released_on" = COALESCE("release"."released_on", ("release"."publish_at" AT TIME ZONE 'Europe/Lisbon')::date),
         "publish_at" = NULL,
         "updated_at" = now()
    FROM "due"
   WHERE "release"."id" = "due"."id"
  RETURNING "release"."id" AS "release_id",
            "release"."type" AS "release_type",
            "release"."published_at" AS "published_at"
), "stamped_episodes" AS (
  UPDATE "studio_tracks" AS "episode"
     SET "published_at" = "published"."published_at",
         "followers_notified_at" = now()
    FROM "published"
   WHERE "episode"."release_id" = "published"."release_id"
     AND "published"."release_type" = 'podcast'
     AND "episode"."published_at" IS NULL
     AND "episode"."audio_key" IS NOT NULL
     AND "episode"."duration_seconds" IS NOT NULL
)
SELECT "release_id" FROM "published"`;

/**
 * Studio v3: the once-a-minute drop. `@Cron` fires in every replica, so the
 * sweep is held to one by a session-level `pg_try_advisory_lock` on a
 * dedicated `QueryRunner` (the `SubprofileFeedSyncService` pattern: the
 * unlock lands on the connection that took the lock, and a crash frees it
 * when that connection drops). After the statement commits, each published
 * release goes to `StudioReleaseAlertsListener` through the v2
 * `studio.release.published` event, which alerts followers and reminder
 * holders once and pre-saves for the latter.
 */
@Injectable()
export class StudioScheduledReleasesService {
  private readonly logger = new Logger(StudioScheduledReleasesService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async publishDueReleases(): Promise<void> {
    if (!isFeatureLaunched('studio')) return;
    const lockRunner = this.dataSource.createQueryRunner();
    let hasLock = false;
    try {
      await lockRunner.connect();
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [SCHEDULED_RELEASES_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Scheduled drop skipped: another process holds the lock',
        );
        return;
      }
      hasLock = true;
      await this.publishDue();
    } catch (error) {
      this.logger.warn(`Scheduled drop failed: ${String(error)}`);
    } finally {
      try {
        if (hasLock) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [
            SCHEDULED_RELEASES_LOCK_KEY,
          ]);
        }
      } catch (error) {
        this.logger.warn(`Scheduled drop unlock failed: ${String(error)}`);
      } finally {
        await lockRunner.release().catch((error: unknown) => {
          this.logger.warn(
            `Scheduled drop connection release failed: ${String(error)}`,
          );
        });
      }
    }
  }

  /** One tick: publish what is due, then hand each id to the listener. */
  async publishDue(): Promise<string[]> {
    const rows: { release_id: string }[] = await this.dataSource.query(
      SCHEDULED_RELEASE_CLAIM_SQL,
      [STUDIO_LIMITS.scheduledReleasesPerTick],
    );
    const releaseIds = rows.map((row) => row.release_id);
    for (const releaseId of releaseIds) {
      this.eventEmitter.emit(STUDIO_RELEASE_PUBLISHED, {
        releaseId,
      } satisfies StudioReleasePublishedEvent);
    }
    return releaseIds;
  }
}
