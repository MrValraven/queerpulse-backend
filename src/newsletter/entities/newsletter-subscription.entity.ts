import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Lifecycle of a newsletter address under double opt-in. */
export type NewsletterStatus = 'pending' | 'confirmed' | 'unsubscribed';

/**
 * One row per email address that has interacted with the newsletter form.
 *
 * Double opt-in: `POST /newsletter/subscribe` upserts a `pending` row and mails
 * an unguessable `confirmToken`; the address only becomes `confirmed` once that
 * link is opened (`GET /newsletter/confirm`). `email` is stored lowercased by
 * the service and carries a UNIQUE constraint so the same address is a single
 * row across re-subscribes — the subscribe path never reveals whether the row
 * already existed.
 *
 * Self-serve unsubscribe (`GET /newsletter/unsubscribe`) reuses the same
 * `confirmToken` rather than minting a second secret: once issued it is a
 * stable, unguessable per-subscriber key good for both proving "yes, open
 * this pending confirmation" and, later, "yes, stop sending to this address."
 */
@Entity('newsletter_subscriptions')
export class NewsletterSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lowercased by the service before persisting; UNIQUE at the DB level. */
  @Column({ type: 'varchar', unique: true })
  email!: string;

  @Column({ type: 'varchar', default: 'pending' })
  status!: NewsletterStatus;

  /** Unguessable double-opt-in token; rotated on every fresh subscribe. */
  @Column({ type: 'varchar' })
  confirmToken!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /** Set the moment the confirmation link is opened; null while pending. */
  @Column({ type: 'timestamptz', nullable: true })
  confirmedAt!: Date | null;

  /** Set the moment `GET /newsletter/unsubscribe` transitions the row to
   *  `unsubscribed`; null until then. Mirrors `confirmedAt`'s watermark shape. */
  @Column({ type: 'timestamptz', nullable: true })
  unsubscribedAt!: Date | null;
}
