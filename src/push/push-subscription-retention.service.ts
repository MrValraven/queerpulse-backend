import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { deleteInBatches } from '../common/batched-delete';
import { PushSubscription } from './entities/push-subscription.entity';

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Prunes stale push subscriptions. Hard-dead endpoints (a 404/410 from the push
 * service) are already deleted inline by `PushService.sendToUser` at send time,
 * so those never accumulate. What this catches is the other leak: a device that
 * simply goes quiet — the browser is uninstalled, permission revoked without a
 * gone status, or the member just stops using it — leaving a row that is never
 * delivered to again and never cleaned up.
 *
 * A subscription is stale when nothing has confirmed it alive within the
 * window: `last_used_at` older than the threshold, or — for a subscription that
 * was created but never once delivered to — `created_at` older than it.
 *
 * Two things refresh `last_used_at`: a successful send (`PushService.sendToUser`)
 * and a (re)subscribe from the device itself (`PushService.saveSubscription`).
 * The second one exists because the first is not enough on its own — a device
 * that is always online receives no DM pushes at all (the listener skips online
 * recipients), so a healthy device could go 90 days without a single successful
 * send and be pruned while the browser still held a valid subscription.
 *
 * REMAINING GAP: the web client only re-posts its subscription when the
 * endpoint has actually drifted, so a quiet, healthy, never-rotating device
 * still ages out. Closing it needs the client to re-post on boot whenever its
 * last successful sync is older than the window (see `usePushSubscription`'s
 * `syncSubscriptionHealth`, which currently returns early when the endpoint is
 * unchanged).
 *
 * Single-instance job — safe because the app runs one scheduler; the delete is
 * idempotent and batched, so an overlapping tick or a future scale-out only
 * removes rows that still match. Errors are swallowed and logged so a
 * @nestjs/schedule handler rejection can't crash the process; the next tick
 * retries.
 */
@Injectable()
export class PushSubscriptionRetentionService {
  private readonly logger = new Logger(PushSubscriptionRetentionService.name);

  constructor(
    @InjectRepository(PushSubscription)
    private readonly subscriptions: Repository<PushSubscription>,
    private readonly config: ConfigService,
  ) {}

  @Cron(CronExpression.EVERY_DAY_AT_2AM)
  async purgeStaleSubscriptions(): Promise<void> {
    try {
      const staleDays = this.config.get<number>(
        'retention.pushSubscriptionStaleDays',
        90,
      );
      const batchSize = this.config.get<number>('retention.batchSize', 1000);
      const maxBatches = this.config.get<number>(
        'retention.maxBatchesPerRun',
        50,
      );
      const cutoff = new Date(Date.now() - staleDays * MILLISECONDS_PER_DAY);
      const removed = await deleteInBatches(
        this.subscriptions,
        'COALESCE(last_used_at, created_at) < :cutoff',
        { cutoff },
        { batchSize, maxBatches },
      );
      if (removed > 0) {
        this.logger.log(`Purged ${removed} stale push subscription(s)`);
      }
    } catch (error) {
      this.logger.error(
        `Push-subscription retention failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    }
  }
}
