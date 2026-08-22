import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One member's live calendar-feed credential.
 *
 * A stored random token, NOT a derived signature. The previous design
 * (`<userId>.<HMAC(userId)>` keyed on `JWT_ACCESS_SECRET`) could not be revoked
 * without a platform-wide secret rotation, disclosed the member's internal uuid
 * to whichever calendar provider the URL was pasted into, and never expired.
 * Feed URLs get pasted into Google/Apple Calendar, synced across devices, and
 * left in browser history and support tickets, so per-member revocation is the
 * feature that matters — `DELETE /me/calendar-feed-token` drops this row and
 * the next mint issues a fresh one.
 *
 * `user_id` is UNIQUE: exactly one live token per member, so re-opening the
 * subscribe affordance returns the same URL rather than quietly invalidating
 * the calendar subscription the member already has.
 *
 * See `AddCalendarFeedTokens1793510000000` for why the token is stored in the
 * clear rather than hashed.
 */
@Entity('calendar_feed_tokens')
export class CalendarFeedToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_calendar_feed_tokens_user', { unique: true })
  @Column({ type: 'uuid' })
  userId!: string;

  /** 32 random bytes, hex-encoded (64 chars). */
  @Index('UQ_calendar_feed_tokens_token', { unique: true })
  @Column({ type: 'varchar', length: 64 })
  token!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  /**
   * Last time a calendar app actually polled the feed with this token. Purely
   * observational (it tells a member, or an admin handling a report, whether a
   * leaked URL is still being used); nothing gates on it.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastUsedAt!: Date | null;
}
