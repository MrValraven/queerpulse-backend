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
}
