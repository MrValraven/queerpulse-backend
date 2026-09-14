import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Deletes `feature_usage_daily` rows past the retention window.
 *
 * No batching, unlike `NotificationRetentionService`. The table gains at most
 * 24 rows a day, so a sweep past a 24-month window removes 24 rows on a normal
 * night and the whole table is small enough that a single statement is never a
 * long-running lock.
 */
@Injectable()
export class FeatureUsageRetentionService {
  private readonly logger = new Logger(FeatureUsageRetentionService.name);

  constructor(
    @InjectRepository(FeatureUsageDaily)
    private readonly featureUsage: Repository<FeatureUsageDaily>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_1AM)
  async purgeOldUsageRows(): Promise<void> {
    try {
      const retentionDays = this.config.get<number>(
        'retention.featureUsageDays',
        730,
      );
      const cutoff = new Date(Date.now() - retentionDays * MILLISECONDS_PER_DAY)
        .toISOString()
        .slice(0, 10);

      await this.featureUsage
        .createQueryBuilder()
        .delete()
        .from(FeatureUsageDaily)
        .where('day < :cutoff', { cutoff })
        .execute();
    } catch (error) {
      this.logger.error(
        'Failed to purge old feature usage rows',
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
