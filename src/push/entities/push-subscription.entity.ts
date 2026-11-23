import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('push_subscriptions')
@Unique('UQ_push_subscriptions_endpoint', ['endpoint'])
export class PushSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_push_subscriptions_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  endpoint!: string;

  @Column({ type: 'text' })
  p256dh!: string;

  @Column({ type: 'text' })
  auth!: string;

  @Column({ type: 'text', nullable: true })
  userAgent!: string | null;

  /**
   * The refresh-token family (the signed-in session, `RefreshToken.familyId`)
   * that last registered this device, taken from the `sid` claim of the
   * access token that called `/push/subscribe` (SEC-12).
   *
   * Signing that session out removes the row (see
   * `PushService.handleSessionRevoked`), so a device signed out remotely stops
   * receiving the member's pushes. NULL for rows saved before the column
   * existed and for a subscribe that carried no `sid`; those rows keep the
   * older rule and go only when the member has no live session anywhere.
   */
  @Column({ type: 'uuid', nullable: true })
  sessionFamilyId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * When the DEVICE last told us it holds this subscription: stamped by every
   * `/push/subscribe`, which the client re-posts once per signed-in page load
   * and at least weekly. The 90-day retention purge reads it.
   *
   * Deliveries leave it alone (SEC-12). A delivery proves only that the push
   * service accepted the message, which keeps happening for a lost phone or a
   * signed-out shared computer, so stamping it on delivery kept those devices
   * subscribed for as long as pushes kept arriving.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;
}
