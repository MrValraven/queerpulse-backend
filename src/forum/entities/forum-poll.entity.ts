import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A poll attached to a forum thread. At most ONE per thread — enforced by the
 * unique index below, not by a service check, because a second poll on a thread
 * is not a state the read path can render. The options live in
 * `forum_poll_option` and the ballots in `forum_poll_vote`.
 *
 * No relation decorators: the forum module declares bare `uuid` columns and
 * lets the migration own the foreign keys (`FK_forum_poll_thread_id`,
 * `ON DELETE CASCADE` — a poll has no meaning without its thread).
 */
@Entity('forum_poll')
@Index('UQ_forum_poll_thread_id', ['threadId'], { unique: true })
export class ForumPoll {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // The thread this poll belongs to. Unique, so "the poll" of a thread is
  // always a single row and the read path never has to pick between two.
  @Column({ type: 'uuid' })
  threadId!: string;

  // False: a member picks exactly one option. True: they may pick several.
  // The ballot table's unique key is `(option_id, user_id)` either way — see
  // `ForumPollVote` — so this flag only tells the service how many rows one
  // member is allowed to hold, never how the constraint is shaped.
  @Column({ type: 'boolean', default: false })
  allowMultiple!: boolean;

  // When voting shuts. NULL means the poll stays open as long as the thread
  // does. Deliberately independent of `ForumThread.closesAt`: a thread can keep
  // taking replies after its poll has closed, and a poll can close early.
  // Compared at write time by the vote path, never by a scheduled job — a
  // timestamp checked on write cannot drift and needs nothing scheduled.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  closesAt!: Date | null;

  // Millisecond precision, matching `forum_thread`/`forum_post` on this table's
  // side of the schema (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`).
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
