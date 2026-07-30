import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deleteInBatches } from '../common/batched-delete';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import {
  DataExportJob,
  DataExportStatus,
} from './entities/data-export-job.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Retention for two account-lifecycle stores that otherwise grow forever:
 *   1. `data_export_job` — each row archives a member's FULL personal-data
 *      export in a JSONB column. Left alone the table accumulates every export
 *      anyone ever requested, indefinitely, and the `Expired` status the entity
 *      declares is never actually set (dead code). This nulls the payload and
 *      flips the status to `Expired` once the archive is old enough — which both
 *      reclaims the storage and makes `Expired` a real, reachable state.
 *   2. `account_reauth_token` — short-lived step-up tokens that are never
 *      purged after they expire.
 *
 * Single-instance jobs — safe because the app runs one scheduler. Both are
 * idempotent condition-based writes, so an overlapping tick (or a future
 * scale-out) only ever touches rows that still match; if we scale out, move
 * them behind a distributed lock or a dedicated worker to avoid duplicated
 * scans. Every handler swallows its own errors: @nestjs/schedule does not wrap
 * handlers, so an escaping rejection becomes an unhandledRejection that can take
 * the process down. The next tick retries whatever this one missed.
 */
@Injectable()
export class AccountRetentionService {
  private readonly logger = new Logger(AccountRetentionService.name);

  constructor(
    @InjectRepository(DataExportJob)
    private readonly dataExportJobs: Repository<DataExportJob>,
    @InjectRepository(AccountReauthToken)
    private readonly reauthTokens: Repository<AccountReauthToken>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async expireOldDataExportArchives(): Promise<void> {
    try {
      const retentionDays = this.config.get<number>(
        'retention.dataExportArchiveDays',
        30,
      );
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(Date.now() - retentionDays * MILLISECONDS_PER_DAY);

      // Only `ready` archives carry a payload worth reclaiming; expiring those
      // is what makes the `Expired` status reachable. `COALESCE` falls back to
      // the request time for the (unexpected) row that is ready without a
      // generated timestamp, so such a row can never become un-ageable.
      let totalExpired = 0;
      for (let batchIndex = 0; batchIndex < maxBatches; batchIndex += 1) {
        const result = await this.dataExportJobs
          .createQueryBuilder()
          .update(DataExportJob)
          .set({ status: DataExportStatus.Expired, data: null })
          .where(
            `id IN (SELECT id FROM data_export_job WHERE status = :ready AND COALESCE(generated_at, requested_at) < :cutoff LIMIT :batchSize)`,
            {
              ready: DataExportStatus.Ready,
              cutoff,
              batchSize,
            },
          )
          .execute();
        const expired = result.affected ?? 0;
        totalExpired += expired;
        if (expired < batchSize) {
          break;
        }
      }
      if (totalExpired > 0) {
        this.logger.log(`Expired ${totalExpired} data-export archive(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Data-export retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }

  @Cron(CronExpression.EVERY_6_HOURS)
  async purgeExpiredReauthTokens(): Promise<void> {
    try {
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      // These tokens live only minutes; once past `expires_at` they can never be
      // redeemed again, so there is no grace window to keep — delete on expiry.
      const removed = await deleteInBatches(
        this.reauthTokens,
        'expires_at < :now',
        { now: new Date() },
        { batchSize, maxBatches },
      );
      if (removed > 0) {
        this.logger.log(`Purged ${removed} expired reauth token(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Reauth-token retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
