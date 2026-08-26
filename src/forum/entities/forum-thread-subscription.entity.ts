import { CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * One member following one forum thread (SOC-13).
 *
 * A row exists iff the member wants to hear about new replies. There is no
 * `muted` flag and no soft state: unfollowing deletes the row, so "am I
 * following this?" is a plain existence check and a repeat follow is an
 * `ON CONFLICT DO NOTHING` insert.
 *
 * Rows are written from three places, all in `ForumSubscriptionsService`:
 *  - the thread's author, when the thread is created;
 *  - any member, when they post a reply in the thread;
 *  - the member themselves, via the Follow toggle on the thread page.
 *
 * The composite primary key is `(threadId, userId)` — see
 * `CreateForumThreadSubscription1794710000000` for why the identity IS the key
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
