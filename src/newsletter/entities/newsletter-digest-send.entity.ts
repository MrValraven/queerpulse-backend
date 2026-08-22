import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * The per-subscriber ledger for one digest mailing: one row per
 * (batch, subscriber), claimed and stamped individually.
 *
 * Before this, publishing an issue awaited an SMTP round trip per confirmed
 * subscriber INSIDE the publish request, and stamped a single `digestSentAt`
 * only after the last one. Two things followed from that: the request blocked
 * for `subscribers * SMTP round trip` (up to 16s each against a degraded host),
 * and a proxy timeout or a restart part-way through left the issue looking
 * unsent, so the next ship re-mailed everyone who had already received it.
 *
 * A row here is the unit of "this person, this mailing, exactly once".
 * `UQ_newsletter_digest_sends_batch_subscription` is what makes re-queueing a
 * mailing a no-op instead of a duplicate, and `sent_at` is what makes a
 * mid-drain crash cost at most the messages actually in flight.
 */
@Entity('newsletter_digest_sends')
@Unique('UQ_newsletter_digest_sends_batch_subscription', [
  'batchId',
  'subscriptionId',
])
// The drain's claim predicate, exactly: unsent rows, oldest lease first. Partial
// on `sent_at IS NULL` so the index stays the size of the OUTSTANDING queue
// rather than of every digest ever mailed.
@Index('IDX_newsletter_digest_sends_pending', ['claimedAt'], {
  where: '"sent_at" IS NULL',
})
export class NewsletterDigestSend {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  batchId!: string;

  @Column({ type: 'uuid' })
  subscriptionId!: string;

  /** Stamped once the message is actually handed to the transport. */
  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;

  /**
   * Incremented by the claim itself, BEFORE the send is attempted, so a row
   * that kills the process mid-send still burns an attempt and cannot be
   * retried forever.
   */
  @Column({ type: 'int', default: 0 })
  attempts!: number;

  /**
   * When the current attempt was claimed. Doubles as the LEASE: a claimed row
   * is invisible to the next tick until the lease expires, which is what stops
   * a drain slower than the cron interval from mailing the same person twice.
   */
  @Column({ type: 'timestamptz', nullable: true })
  claimedAt!: Date | null;

  /** Last delivery failure, kept for support rather than for retry logic. */
  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
