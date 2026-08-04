import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deleteInBatches } from '../common/batched-delete';
import { Notification } from './entities/notification.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deletes READ notifications older than the configured retention window. The
 * `notifications` table grows on every domain event (connections, vouches,
 * messages, events, mentions, forum replies) and nothing ever removed rows, so
 * it accretes without bound.
 *
 * Unread notifications are never deleted regardless of age: a member who hasn't
 * seen it still needs it in their bell. Only `read = true` rows are eligible.
 *
 * Single-instance job — safe because the app runs one scheduler. The delete is
 * idempotent and batched (see `deleteInBatches`), so an overlapping tick, or a
 * future scale-out, only ever removes rows that still match. Errors are
 * swallowed and logged: an escaping rejection from a @nestjs/schedule handler
 * becomes an unhandledRejection that can crash the process; the next tick
 * retries.
 */
@Injectable()
export class NotificationRetentionService {
  private readonly logger = new Logger(NotificationRetentionService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notifications: Repository<Notification>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async purgeOldReadNotifications(): Promise<void> {
    try {
      const retentionDays = this.config.get<number>(
        'retention.notificationReadDays',
        90,
      );
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(
        Date.now() - retentionDays * MILLISECONDS_PER_DAY,
      );
      const removed = await deleteInBatches(
        this.notifications,
        'read = true AND created_at < :cutoff',
        { cutoff },
        { batchSize, maxBatches },
      );
      if (removed > 0) {
        this.logger.log(`Purged ${removed} old read notification(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Notification retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
