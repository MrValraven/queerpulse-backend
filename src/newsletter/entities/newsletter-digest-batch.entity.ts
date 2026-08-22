import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** One curated digest entry, resolved to the text that goes in the mail. */
export interface NewsletterDigestItem {
  title: string;
  blurb: string;
}

/**
 * One members'-digest mailing, queued when a magazine issue ships.
 *
 * The rendered content is snapshotted HERE, once per mailing rather than once
 * per recipient, so the drain cron can build every message without reaching
 * back into the magazine module (and so a piece edited after the issue shipped
 * cannot silently change what half the list receives).
 *
 * `issue_id` is UNIQUE, which is what makes queueing idempotent: shipping an
 * issue is re-runnable (later pieces clear their publish gate on a second
 * ship), and every re-run has to resolve to the same mailing rather than a
 * second one. It is a plain uuid with no FK — the newsletter module owns this
 * table and does not otherwise depend on the magazine schema.
 */
@Entity('newsletter_digest_batches')
export class NewsletterDigestBatch {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_newsletter_digest_batches_issue', { unique: true })
  @Column({ type: 'uuid' })
  issueId!: string;

  @Column({ type: 'varchar', length: 64 })
  issueNumber!: string;

  @Column({ type: 'text' })
  issueTitle!: string;

  @Column({ type: 'jsonb' })
  items!: NewsletterDigestItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
