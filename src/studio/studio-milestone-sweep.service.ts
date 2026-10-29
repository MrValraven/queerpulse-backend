import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import { STUDIO_FIRST_PLACEMENT_THRESHOLD } from './studio-milestones';
import { personaMemberUserIdsSql } from './studio-persona-members';
import {
  notWithheldTrackSql,
  publiclyListedPlaylistSql,
} from './studio-playlist-visibility';
import { STUDIO_ARTIST_PERSONA_KINDS } from './studio.constants';

/**
 * Postgres advisory-lock key for the first placement sweep. Advisory locks
 * share ONE global namespace, so this differs from every other key in
 * `src/`: the cinema reconciliation (793640001), the identity mailbox
 * reconciliation (793_640_002_000), Go together's matching and retention runs
 * (793_640_003_000 / 793_640_003_001), the persona feed sweep
 * (793_640_004_000), the scheduled drop (793_640_005_000), the milestone
 * sweep (793_640_006_000, this key), the listening history prune
 * (793_640_007_000), the purchase expiry (793_640_008_000) and the migration
 * lock (481_205_733_107_400).
 */
export const MILESTONE_SWEEP_LOCK_KEY = 793_640_006_000;

/**
 * Writes one `first_placement` milestone for every artist persona (kinds in
 * `$1`, threshold `$2`) with a listenable track (published release, track
 * not withheld) on a publicly listed playlist that no persona member owns,
 * so a self-placement by the creator or a co-owner earns nothing. One
 * statement covers every path to "publicly listed" and doubles as the
 * backfill. The milestone is dated at the earliest `added_at` among the
 * qualifying playlist entries (the lateral `MIN`), so a placement the first
 * run after deploy finds keeps the day it happened, and a persona with no
 * qualifying entry reads a null `MIN` and writes nothing. The entry date
 * reads today's qualifying entries: when an earlier entry has since left
 * its playlist, or its playlist turned private, the date is the earliest
 * entry still standing. The `NOT EXISTS` guard and `ON CONFLICT DO
 * NOTHING` keep a reached milestone as it was, and a playlist that later
 * turns private deletes nothing. Wrapped in `WITH ... SELECT` so
 * `DataSource.query` returns the written count.
 */
export const FIRST_PLACEMENT_SWEEP_SQL = `WITH "written" AS (
INSERT INTO "studio_artist_milestones" ("subprofile_id", "kind", "threshold", "reached_at")
SELECT "persona"."id", 'first_placement', $2::int, "placement"."first_added_at"
  FROM "subprofiles" "persona"
 CROSS JOIN LATERAL (
   SELECT MIN("entry"."added_at") AS "first_added_at"
     FROM "studio_releases" "release"
    INNER JOIN "studio_tracks" "track" ON "track"."release_id" = "release"."id"
    INNER JOIN "studio_playlist_tracks" "entry" ON "entry"."track_id" = "track"."id"
    INNER JOIN "studio_playlists" "playlist" ON "playlist"."id" = "entry"."playlist_id"
    WHERE "release"."subprofile_id" = "persona"."id"
      AND "release"."status" = 'published'
      AND ${notWithheldTrackSql('track')}
      AND ${publiclyListedPlaylistSql('playlist')}
      AND "playlist"."user_id" NOT IN ${personaMemberUserIdsSql('"persona"."id"')}
 ) "placement"
 WHERE "persona"."kind"::text = ANY($1::text[])
   AND "placement"."first_added_at" IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM "studio_artist_milestones" "reached"
      WHERE "reached"."subprofile_id" = "persona"."id"
        AND "reached"."kind" = 'first_placement'
   )
ON CONFLICT DO NOTHING
RETURNING "id"
)
SELECT COUNT(*)::int AS "written_count" FROM "written"`;

/**
 * Studio dashboard: the hourly first placement sweep. `@Cron` fires in every
 * replica, so the sweep is held to one by a session-level
 * `pg_try_advisory_lock` on a dedicated `QueryRunner` (the
 * `StudioScheduledReleasesService` pattern: the unlock lands on the
 * connection that took the lock, and a crash frees it when that connection
 * drops). Every failure is logged and the scheduler sees none of them.
 */
@Injectable()
export class StudioMilestoneSweepService {
  private readonly logger = new Logger(StudioMilestoneSweepService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_HOUR)
  async sweepFirstPlacements(): Promise<void> {
    if (!isFeatureLaunched('studio')) return;
    const lockRunner = this.dataSource.createQueryRunner();
    let hasLock = false;
    try {
      await lockRunner.connect();
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [MILESTONE_SWEEP_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Milestone sweep skipped: another process holds the lock',
        );
        return;
      }
      hasLock = true;
      await this.markFirstPlacements();
    } catch (error) {
      this.logger.warn(`Milestone sweep failed: ${String(error)}`);
    } finally {
      try {
        if (hasLock) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [
            MILESTONE_SWEEP_LOCK_KEY,
          ]);
        }
      } catch (error) {
        this.logger.warn(`Milestone sweep unlock failed: ${String(error)}`);
      } finally {
        await lockRunner.release().catch((error: unknown) => {
          this.logger.warn(
            `Milestone sweep connection release failed: ${String(error)}`,
          );
        });
      }
    }
  }

  /** One pass: writes the first placements reached since the last pass. */
  async markFirstPlacements(): Promise<number> {
    const rows: { written_count: number | string }[] =
      await this.dataSource.query(FIRST_PLACEMENT_SWEEP_SQL, [
        [...STUDIO_ARTIST_PERSONA_KINDS],
        STUDIO_FIRST_PLACEMENT_THRESHOLD,
      ]);
    return Number(rows[0]?.written_count ?? 0);
  }
}
