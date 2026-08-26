import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deleteInBatches } from '../common/batched-delete';
import { MembershipCardScan } from './entities/membership-card-scan.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * The window `membership-card-scan.entity.ts` promises. Fixed rather than
 * configurable on purpose: this log exists for dispute resolution and for
 * spotting a shared or leaked card, and both of those questions are answered
 * inside a season. A deployment that could quietly widen the window to years
 * would turn an operational record into the behavioural history the design
 * forbids, so the ceiling is in the code.
 */
export const CARD_SCAN_RETENTION_DAYS = 90;

/**
 * Deletes card verification rows older than 90 days.
 *
 * Same shape as `NotificationRetentionService`: one daily cron, batched
 * deletes through `deleteInBatches` so a large table never takes a long lock,
 * and errors swallowed and logged, because an escaping rejection from a
 * @nestjs/schedule handler becomes an unhandledRejection that can crash the
 * process. The next tick retries, and the delete is idempotent.
 */
@Injectable()
export class CardScanRetentionService {
  private readonly logger = new Logger(CardScanRetentionService.name);

  constructor(
    @InjectRepository(MembershipCardScan)
    private readonly scans: Repository<MembershipCardScan>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async purgeOldCardScans(): Promise<void> {
    try {
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(
        Date.now() - CARD_SCAN_RETENTION_DAYS * MILLISECONDS_PER_DAY,
      );
      const removed = await deleteInBatches(
        this.scans,
        'scanned_at < :cutoff',
        { cutoff },
        { batchSize, maxBatches },
      );
      if (removed > 0) {
        this.logger.log(
          `Purged ${removed} card verification record(s) older than ${CARD_SCAN_RETENTION_DAYS} days`,
        );
      }
    } catch (error) {
      this.logger.error(
        `Card verification retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
