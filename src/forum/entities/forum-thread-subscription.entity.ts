import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
} from 'typeorm';

/**
 * One member's relationship to one forum thread (SOC-13, then C7/PRD-170).
 *
 * A row used to mean exactly one thing: this member follows this thread. It now
 * carries TWO independent facts, because the forum needed a read watermark and
 * a watermark must never be a follow:
 *
 *  - `isFollowing` — do they want to hear about new replies;
 *  - `lastReadAt` — when they last opened the thread.
 *
 * Keeping both on one row is what lets a member open a thread (stamping
 * `lastReadAt`, `isFollowing` untouched) without being signed up for a
 * notification per reply for the rest of the thread's life. Merging the two
 * back into a bare existence check would silently re-create exactly that.
 *
 * Because a row can now exist for a member who is NOT following, "am I
 * following this?" is `is_following = true`, never `EXISTS`. Every read in
 * `ForumSubscriptionsService` carries that predicate; unfollowing clears the
 * flag rather than deleting the row, so an unfollow does not also throw away
 * where the member had read to.
 *
 * Rows are written from four places, all in `ForumSubscriptionsService`:
 *  - the thread's author, when the thread is created;
 *  - any member, when they post a reply in the thread;
 *  - the member themselves, via the Follow toggle on the thread page;
 *  - the member themselves, by opening the thread (watermark only).
 *
 * The composite primary key is `(threadId, userId)` — see
 * `CreateForumThreadSubscription1794710100000` for why the identity IS the key
 * rather than a surrogate uuid. `SnakeNamingStrategy` maps both properties to
 * `thread_id`/`user_id`, so neither carries a `name:`.
 */
@Entity('forum_thread_subscription')
export class ForumThreadSubscription {
  @PrimaryColumn({ type: 'uuid' })
  threadId!: string;

  // Indexed for the reverse read ("which threads does this member follow"),
  // which the batched list mapper issues as
  // `user_id = :viewer AND thread_id IN (...)`. The primary key already covers
  // the forward read (a thread's subscriber fan-out).
  @Index('IDX_forum_thread_subscription_user_id')
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  /**
   * Does this member want to hear about new replies (C7/PRD-170)?
   *
   * `true` for every row written before the read watermark existed, which is
   * what the migration's `DEFAULT true` backfill encodes: back then a row's
   * mere existence WAS the follow. A row created by the watermark route starts
   * `false`, and stays false unless the member follows explicitly.
   */
  @Column({ type: 'boolean', default: true })
  isFollowing!: boolean;

  /**
   * When this member last opened the thread (C7/PRD-170) — the watermark the
   * unread badge counts replies against.
   *
   * NULL means "never opened", which is deliberately distinguishable from
   * "opened and nothing new since": the first reads as no badge at all rather
   * than as a thread with zero unread replies. `SnakeNamingStrategy` maps this
   * to `last_read_at`, so it carries no `name:`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  lastReadAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
