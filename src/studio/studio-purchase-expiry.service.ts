import { Injectable, Logger } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DataSource } from 'typeorm';
import { isFeatureLaunched } from '../launchedFeatures';
import { StudioKeptAudioService } from './studio-kept-audio.service';
import { describePlayErrorWithoutIds } from './studio-play-log';
import {
  STUDIO_PURCHASE_EXPIRED,
  StudioPurchaseEvent,
} from './studio-purchase.events';

/**
 * Postgres advisory-lock key for the daily purchase expiry. Advisory locks
 * share ONE global namespace, so this differs from every other key in
 * `src/`: the cinema reconciliation (793640001), the identity mailbox
 * reconciliation (793_640_002_000), Go together's matching and retention runs
 * (793_640_003_000 / 793_640_003_001), the persona feed sweep
 * (793_640_004_000), the scheduled drop (793_640_005_000), the milestone
 * sweep (793_640_006_000), the listening history prune (793_640_007_000), the
 * purchase expiry (793_640_008_000, this key) and the migration lock
 * (481_205_733_107_400).
 */
export const PURCHASE_EXPIRY_LOCK_KEY = 793_640_008_000;

/** Rows one expiry batch may move; a shorter batch ends the run. */
const EXPIRE_BATCH_SIZE = 500;

/**
 * One expiry batch (contract 4.3): pending purchases older than 30 days,
 * oldest first, skipping rows another transaction holds. Wrapped in
 * `WITH ... SELECT` so the driver returns the expired ids as rows.
 */
export const EXPIRE_BATCH_SQL = `WITH "expired" AS (
  UPDATE "studio_purchases"
     SET "status" = 'expired', "decided_at" = now(), "updated_at" = now()
   WHERE "id" IN (
     SELECT "id" FROM "studio_purchases"
      WHERE "status" = 'pending'
        AND "created_at" < now() - interval '30 days'
      ORDER BY "created_at" ASC
      LIMIT ${EXPIRE_BATCH_SIZE}
      FOR UPDATE SKIP LOCKED
   )
  RETURNING "id"
)
SELECT "id" FROM "expired" ORDER BY "id"`;

/**
 * Studio purchases: the daily expiry of pending claims older than 30 days.
 * `@Cron` fires in every replica, so the run is held to one by a
 * session-level `pg_try_advisory_lock` on a dedicated `QueryRunner` (the
 * `StudioListeningPruneService` pattern: the unlock lands on the connection
 * that took the lock). Each batch commits in its own transaction, then emits
 * `studio.purchase.expired` per id. Under the same lock the run retries
 * pending kept-file copies and sweeps orphaned kept rows. Every failure is
 * logged with its error class and the scheduler sees none of them. The log
 * line carries the expired count only.
 */
@Injectable()
export class StudioPurchaseExpiryService {
  private readonly logger = new Logger(StudioPurchaseExpiryService.name);

  constructor(
    private readonly dataSource: DataSource,
    private readonly eventEmitter: EventEmitter2,
    private readonly keptAudio: StudioKeptAudioService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_4AM)
  async runDaily(): Promise<void> {
    if (!isFeatureLaunched('studio')) return;
    const lockRunner = this.dataSource.createQueryRunner();
    let hasLock = false;
    try {
      await lockRunner.connect();
      const lockRows = (await lockRunner.query(
        'SELECT pg_try_advisory_lock($1) AS locked',
        [PURCHASE_EXPIRY_LOCK_KEY],
      )) as { locked: boolean }[];
      if (lockRows[0]?.locked !== true) {
        this.logger.debug(
          'Purchase expiry skipped: another process holds the lock',
        );
        return;
      }
      hasLock = true;
      // Each step has its own catch, so one failure leaves the others to run.
      const expiredIds: string[] = [];
      try {
        await this.expireBatchesInto(expiredIds);
      } catch (error) {
        this.logger.warn(
          `Purchase expiry failed: ${describePlayErrorWithoutIds(error)}`,
        );
      }
      // Counts every batch that committed, a run that failed later included.
      this.logger.log(`Expired ${expiredIds.length} pending Studio purchases`);
      try {
        await this.keptAudio.retryPendingCopies();
      } catch (error) {
        this.logger.warn(
          `Purchase kept copy retry failed: ${describePlayErrorWithoutIds(error)}`,
        );
      }
      try {
        await this.keptAudio.sweepOrphans();
      } catch (error) {
        this.logger.warn(
          `Purchase kept sweep failed: ${describePlayErrorWithoutIds(error)}`,
        );
      }
    } catch (error) {
      this.logger.warn(
        `Purchase expiry failed: ${describePlayErrorWithoutIds(error)}`,
      );
    } finally {
      try {
        if (hasLock) {
          await lockRunner.query('SELECT pg_advisory_unlock($1)', [
            PURCHASE_EXPIRY_LOCK_KEY,
          ]);
        }
      } catch (error) {
        this.logger.warn(
          `Purchase expiry unlock failed: ${describePlayErrorWithoutIds(error)}`,
        );
      } finally {
        await lockRunner.release().catch((error: unknown) => {
          this.logger.warn(
            `Purchase expiry connection release failed: ${describePlayErrorWithoutIds(error)}`,
          );
        });
      }
    }
  }

  /**
   * Expires pending purchases in batches of 500 until a batch returns fewer
   * rows, each batch in its own transaction. After a batch commits, emits
   * `studio.purchase.expired` for the ids it returned. Returns every expired
   * id. A failed batch emits nothing and ends the run with its error.
   */
  async expirePendingOnce(): Promise<string[]> {
    const expiredIds: string[] = [];
    await this.expireBatchesInto(expiredIds);
    return expiredIds;
  }

  /** The batch loop of `expirePendingOnce`: each committed batch's ids land
   *  in `expiredIds` before the next batch starts, so a caller still reads
   *  them after a later batch throws. */
  private async expireBatchesInto(expiredIds: string[]): Promise<void> {
    let batchSize = EXPIRE_BATCH_SIZE;
    while (batchSize >= EXPIRE_BATCH_SIZE) {
      const batchIds = await this.dataSource.transaction(async (manager) => {
        const rows: { id: string }[] = await manager.query(EXPIRE_BATCH_SQL);
        return rows.map((row) => row.id);
      });
      expiredIds.push(...batchIds);
      for (const purchaseId of batchIds) {
        const event: StudioPurchaseEvent = { purchaseId };
        this.eventEmitter.emit(STUDIO_PURCHASE_EXPIRED, event);
      }
      batchSize = batchIds.length;
    }
  }
}
