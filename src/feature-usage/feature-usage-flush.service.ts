import { Injectable, Logger } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';
import { FeatureUsageTallyService } from './feature-usage-tally.service';

/**
 * Moves the in-memory tally into `feature_usage_daily` every five minutes.
 *
 * The write is an ADDITIVE upsert, so a day accumulates across every flush and
 * across restarts rather than being overwritten by the latest interval.
 *
 * Errors are swallowed and logged, and the drained counts go back onto the
 * tally so the next tick retries them. An escaping rejection from a
 * @nestjs/schedule handler becomes an unhandledRejection that can take the
 * process down, which is the same reason every retention cron in this repo
 * catches its own errors.
 */
@Injectable()
export class FeatureUsageFlushService {
  private readonly logger = new Logger(FeatureUsageFlushService.name);

  constructor(
    @InjectRepository(FeatureUsageDaily)
    private readonly featureUsage: Repository<FeatureUsageDaily>,
    private readonly tally: FeatureUsageTallyService,
  ) {}

  @Cron(CronExpression.EVERY_5_MINUTES)
  async flushPendingCounts(): Promise<void> {
    const drained = this.tally.drain();
    if (drained.size === 0) {
      return;
    }

    // `day` is stamped at FLUSH time, not per request. The tick that fires at
    // 00:00 UTC drains counts accumulated since the previous tick (up to the
    // preceding five minutes, spanning the end of yesterday), so up to five
    // minutes of requests near the UTC day boundary can be stamped with the
    // following day. Bounded and immaterial at this panel's daily resolution,
    // so this is a known, accepted skew rather than a bug.
    const day = new Date().toISOString().slice(0, 10);

    // Tracks what is still unwritten. A key is removed the moment its own
    // statement succeeds, so a failure partway through the loop restores only
    // what was never written rather than the whole drained batch, which would
    // otherwise double-count every key that already landed.
    const unwrittenCounts = new Map(drained);

    try {
      // At most 24 statements (one per key in `launchedFeatures`) every five
      // minutes, so a loop is cheaper to read than a built-up multi-row VALUES
      // and costs nothing measurable.
      for (const [featureKey, requestCount] of drained) {
        await this.featureUsage.query(
          `INSERT INTO "feature_usage_daily" ("day", "feature_key", "request_count")
           VALUES ($1, $2, $3)
           ON CONFLICT ("day", "feature_key")
           DO UPDATE SET "request_count" =
             "feature_usage_daily"."request_count" + EXCLUDED."request_count"`,
          [day, featureKey, requestCount],
        );
        unwrittenCounts.delete(featureKey);
      }
    } catch (error) {
      this.tally.restore(unwrittenCounts);
      this.logger.error(
        `Failed to flush feature usage counts, ${unwrittenCounts.size} keys returned to the tally`,
        error instanceof Error ? error.stack : String(error),
      );
    }
  }
}
