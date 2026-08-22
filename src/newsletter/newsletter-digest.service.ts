import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { Cron, CronExpression } from '@nestjs/schedule';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import { MailerService } from '../mailer/mailer.service';
import { NewsletterDigestBatch } from './entities/newsletter-digest-batch.entity';
import { NewsletterDigestSend } from './entities/newsletter-digest-send.entity';
import { NewsletterSubscription } from './entities/newsletter-subscription.entity';
import {
  NEWSLETTER_DIGEST_DUE,
  NewsletterDigestDueEvent,
} from './newsletter.events';

/** How many subscribers one tick mails. At the mailer's 8s connect + 8s socket
 *  timeouts, a fully degraded SMTP host costs at most this many stalled sends
 *  before the tick gives up and the next one carries on. */
const DRAIN_BATCH_SIZE = 25;

/** A row that keeps failing is retired rather than retried forever. Three
 *  attempts covers a transient SMTP outage; a permanently bad address is a
 *  bounce problem, not a retry problem. */
const MAX_ATTEMPTS = 3;

/** How long a claimed row stays invisible to the next tick. Longer than the
 *  worst-case time to mail one batch (25 x 16s = 400s), so a slow drain can
 *  never have its own in-flight rows re-claimed underneath it. */
const CLAIM_LEASE = '15 minutes';

/** Ledger rows written per INSERT when a mailing is queued. */
const INSERT_CHUNK_SIZE = 500;

/** The claim's RETURNING columns, in the DB's own snake_case. */
interface ClaimedDigestSendRow {
  id: string;
  batch_id: string;
  subscription_id: string;
  attempts: number;
}

/** One claimed ledger row, mapped by hand out of {@link ClaimedDigestSendRow}. */
interface ClaimedDigestSend {
  id: string;
  batchId: string;
  subscriptionId: string;
  attempts: number;
}

/**
 * The members' digest mailing: a durable queue with a per-subscriber ledger,
 * drained on a cron.
 *
 * Shipping a magazine issue used to mail the whole confirmed list INLINE, in
 * series, inside the publish request: `subscribers x SMTP round trip` of
 * request time (up to 16s each against a degraded host), a single
 * `digestSentAt` stamped only after the last one, and therefore a re-send to
 * everybody if anything interrupted the loop. There was no record of who had
 * actually been mailed.
 *
 * Now publishing emits {@link NEWSLETTER_DIGEST_DUE}, this service writes one
 * ledger row per confirmed subscriber, and the request returns. Delivery is
 * somebody else's tick.
 */
@Injectable()
export class NewsletterDigestService {
  private readonly logger = new Logger(NewsletterDigestService.name);
  /** In-process re-entrancy guard, on top of the DB-level lease below. */
  private isDraining = false;

  constructor(
    @InjectRepository(NewsletterDigestBatch)
    private readonly batches: Repository<NewsletterDigestBatch>,
    @InjectRepository(NewsletterDigestSend)
    private readonly sends: Repository<NewsletterDigestSend>,
    @InjectRepository(NewsletterSubscription)
    private readonly subscriptions: Repository<NewsletterSubscription>,
    private readonly mailer: MailerService,
  ) {}

  /**
   * Queue one issue's digest for every confirmed subscriber.
   *
   * Fully idempotent, which is what lets the publisher call it on every ship:
   * the batch is keyed on `issue_id` (UNIQUE) and each ledger row on
   * `(batch, subscription)` (UNIQUE), so a re-ship adds only subscribers who
   * confirmed since the first one, and never a second copy for anyone.
   *
   * Awaited by the publisher through `emitAsync`, so a failure here surfaces
   * there and the issue is NOT stamped as sent.
   */
  @OnEvent(NEWSLETTER_DIGEST_DUE)
  async queueDigest(event: NewsletterDigestDueEvent): Promise<void> {
    await this.batches.upsert(
      {
        issueId: event.issueId,
        issueNumber: event.issueNumber,
        issueTitle: event.issueTitle,
        items: event.items,
      },
      ['issueId'],
    );
    const batch = await this.batches.findOne({
      where: { issueId: event.issueId },
    });
    if (!batch) {
      throw new Error(
        `Digest batch for issue ${event.issueNumber} vanished immediately after upsert`,
      );
    }
    const confirmed = await this.subscriptions.find({
      where: { status: 'confirmed' },
      select: ['id'],
    });
    if (confirmed.length === 0) {
      return;
    }
    // Chunked: a confirmed list in the thousands would otherwise be one
    // enormous multi-row INSERT.
    for (
      let offset = 0;
      offset < confirmed.length;
      offset += INSERT_CHUNK_SIZE
    ) {
      const chunk = confirmed.slice(offset, offset + INSERT_CHUNK_SIZE);
      await this.sends
        .createQueryBuilder()
        .insert()
        .into(NewsletterDigestSend)
        .values(
          chunk.map((subscription) => ({
            batchId: batch.id,
            subscriptionId: subscription.id,
          })),
        )
        .orIgnore()
        .execute();
    }
    this.logger.log(
      `Queued issue ${event.issueNumber} digest for ${confirmed.length} subscriber(s)`,
    );
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async drainQueuedDigests(): Promise<void> {
    // A batch of 25 sends can outrun the one-minute cron interval against a slow
    // SMTP host, so a tick that arrives while the previous one is still working
    // stands down. The DB lease below is the real guarantee; this just avoids
    // pointless overlapping work in the common case.
    if (this.isDraining) {
      return;
    }
    this.isDraining = true;
    // @nestjs/schedule does not wrap handlers, so an escaping rejection becomes
    // an unhandledRejection and takes the process down. Mail must never do that.
    try {
      await this.deliverNextBatch();
    } catch (error) {
      this.logger.error(
        `Digest drain failed: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      );
    } finally {
      this.isDraining = false;
    }
  }

  private async deliverNextBatch(): Promise<void> {
    const claimed = await this.claimBatch();
    if (claimed.length === 0) {
      return;
    }

    const batchesById = new Map(
      (
        await this.batches.find({
          where: { id: In([...new Set(claimed.map((row) => row.batchId))]) },
        })
      ).map((batch) => [batch.id, batch]),
    );
    const subscriptionsById = new Map(
      (
        await this.subscriptions.find({
          where: {
            id: In([...new Set(claimed.map((row) => row.subscriptionId))]),
          },
        })
      ).map((subscription) => [subscription.id, subscription]),
    );

    for (const row of claimed) {
      const batch = batchesById.get(row.batchId);
      const subscription = subscriptionsById.get(row.subscriptionId);
      // Consent is re-checked at DELIVERY time, not only at queue time: an
      // address that unsubscribed (or was deleted) between the issue shipping
      // and this tick must not receive the mailing. There is nothing to send
      // and nothing to remember, so the row goes.
      if (!subscription || subscription.status !== 'confirmed') {
        await this.sends.delete({ id: row.id });
        continue;
      }
      if (!batch) {
        await this.sends.update(
          { id: row.id },
          { attempts: MAX_ATTEMPTS, lastError: 'Digest batch is missing' },
        );
        continue;
      }
      try {
        await this.mailer.send(subscription.email, 'digest', {
          issueNumber: batch.issueNumber,
          issueTitle: batch.issueTitle,
          items: batch.items,
        });
        await this.sends.update(
          { id: row.id },
          { sentAt: new Date(), lastError: null },
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.sends.update({ id: row.id }, { lastError: message });
        this.logger.warn(
          `Digest send failed for subscription ${row.subscriptionId} ` +
            `(attempt ${row.attempts} of ${MAX_ATTEMPTS}): ${message}`,
        );
      }
    }
  }

  /**
   * Take the next slice of the queue for THIS tick.
   *
   * The claim is one statement and commits before any mail is attempted, so a
   * process that dies mid-send has already burned the attempt rather than
   * leaving a row to be re-sent on every tick forever. `FOR UPDATE SKIP LOCKED`
   * plus the lease on `claimed_at` mean two drains (a slow tick overlapping the
   * next, or a second replica) divide the queue instead of duplicating it.
   */
  private async claimBatch(): Promise<ClaimedDigestSend[]> {
    const result = await this.sends.query<[ClaimedDigestSendRow[], number]>(
      `
      UPDATE "newsletter_digest_sends"
      SET "attempts" = "attempts" + 1, "claimed_at" = now()
      WHERE "id" IN (
        SELECT "id" FROM "newsletter_digest_sends"
        WHERE "sent_at" IS NULL
          AND "attempts" < $1
          AND ("claimed_at" IS NULL OR "claimed_at" < now() - interval '${CLAIM_LEASE}')
        ORDER BY "claimed_at" NULLS FIRST, "created_at"
        LIMIT $2
        FOR UPDATE SKIP LOCKED
      )
      RETURNING "id", "batch_id", "subscription_id", "attempts"
    `,
      [MAX_ATTEMPTS, DRAIN_BATCH_SIZE],
    );
    // `Repository.query()` hands back the postgres driver's UNSTRUCTURED raw
    // result, and for a statement postgres reports as `UPDATE` that is
    // `[rows, affectedCount]`, not the rows themselves (the query builder's
    // `.returning()` unwraps it for you; raw `.query()` does not). Read as a
    // row array it produced two junk entries on EVERY tick (the nested array
    // and the count), both with `id: undefined`, so the empty-queue early
    // return never fired and the first `sends.delete({ id: undefined })` threw
    // before any mail was attempted, having already burned an attempt on 25
    // real ledger rows.
    const [rows = []] = result;
    return rows.map((row) => ({
      id: row.id,
      batchId: row.batch_id,
      subscriptionId: row.subscription_id,
      attempts: row.attempts,
    }));
  }
}
