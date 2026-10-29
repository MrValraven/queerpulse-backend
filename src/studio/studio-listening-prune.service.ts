import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import { STUDIO_LISTENING_RETENTION_INTERVAL } from './studio-listening-history';

/**
 * Postgres advisory-lock key for the nightly listening history prune.
 * Advisory locks share ONE global namespace, so this differs from every other
 * key in `src/`: the cinema reconciliation (793640001), the identity mailbox
 * reconciliation (793_640_002_000), Go together's matching and retention runs
 * (793_640_003_000 / 793_640_003_001), the persona feed sweep
 * (793_640_004_000), the scheduled drop (793_640_005_000), the milestone
 * sweep (793_640_006_000), the listening history prune (793_640_007_000,
 * this key), the purchase expiry (793_640_008_000) and the migration lock
 * (481_205_733_107_400).
 */
export const LISTENING_PRUNE_LOCK_KEY = 793_640_007_000;

/**
 * Deletes every listen older than the retention window
 * (`STUDIO_LISTENING_RETENTION_INTERVAL`, 13 months) and nothing else: daily
 * play totals and supporter opt-ins are never pruned. Wrapped in
 * `WITH ... SELECT` so `DataSource.query` returns the deleted count.
 */
export const LISTENING_PRUNE_SQL = `WITH "pruned" AS (DELETE FROM "studio_listens" WHERE "played_at" < now() - interval '${STUDIO_LISTENING_RETENTION_INTERVAL}' RETURNING 1) SELECT COUNT(*)::int AS "pruned_count" FROM "pruned"`;

/**
 * Studio listening: the nightly prune of listening history past its
 * retention window. `@Cron` fires in every replica, so the prune is held to
 * one by a session-level `pg_try_advisory_lock` on a dedicated `QueryRunner`
 * (the `StudioMilestoneSweepService` pattern: the unlock lands on the
 * connection that took the lock, and a crash frees it when that connection
 * drops). Every failure is logged and the scheduler sees none of them. The
 * log line carries the deleted count only.
 */
@Injectable()
export class StudioListeningPruneService {
  private readonly logger = new Logger(StudioListeningPruneService.name);

  constructor(private readonly dataSource: DataSource) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async pruneListeningHistory(): Promise<void> {
    if (!isFeatureLaunched('studio')) return;
    const lockRunner = this.dataSource.createQueryRunner();
    let hasLock = false;
    try {
      await lockRunner.connect();
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [LISTENING_PRUNE_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Listening history prune skipped: another process holds the lock',
        );
        return;
      }
      hasLock = true;
      const prunedCount = await this.pruneOnce();
      this.logger.log(`Pruned ${prunedCount} listening history rows`);
    } catch (error) {
      this.logger.warn(`Listening history prune failed: ${String(error)}`);
    } finally {
      try {
        if (hasLock) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [
            LISTENING_PRUNE_LOCK_KEY,
          ]);
        }
      } catch (error) {
        this.logger.warn(
          `Listening history prune unlock failed: ${String(error)}`,
        );
      } finally {
        await lockRunner.release().catch((error: unknown) => {
          this.logger.warn(
            `Listening history prune connection release failed: ${String(error)}`,
          );
        });
      }
    }
  }

  /** One pass: deletes the listens past retention and returns how many. */
  async pruneOnce(): Promise<number> {
    const rows: { pruned_count: number | string }[] =
      await this.dataSource.query(LISTENING_PRUNE_SQL);
    return Number(rows[0]?.pruned_count ?? 0);
  }
}
