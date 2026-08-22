import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A single post within a thread. The oldest post (by `createdAt`) for a
 * given `threadId` is the thread's OP; every later one is a reply — there is
 * no `kind`/`isOp` column, the ordering *is* the distinction (see
 * `ForumPostsService.listPosts`'s oldest-first cursor page). Beyond
 * `threadId`, a post optionally relates to another post in the same thread
 * via `parentPostId`: `null` means a top-level comment on the thread, a
 * value means a nested reply to that specific post.
 */
@Entity('forum_post')
@Index('IDX_forum_post_thread_id_created_at_id', [
  'threadId',
  'createdAt',
  'id',
])
@Index('IDX_forum_post_thread_id_parent_post_id', ['threadId', 'parentPostId'])
export class ForumPost {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_forum_post_thread_id')
  @Column({ type: 'uuid' })
  threadId!: string;

  @Column({ type: 'uuid', nullable: true })
  parentPostId!: string | null;

  @Index('IDX_forum_post_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Column({ type: 'text' })
  body!: string;

  // Denormalized count of `forum_post_vote` rows with `value = 1` for this
  // post, kept in sync by `ForumPostsService.vote` — avoids a `COUNT(*)`
  // join on every post render.
  @Column({ type: 'int', default: 0 })
  voteCount!: number;

  // Denormalization flag marking this post as its thread's opening post (the
  // oldest post). The ordering *is* still the source of truth, but this flag
  // lets the thread-list page batch-load every page's OP in one
  // `WHERE is_op AND thread_id IN (...)` query (no N+1) and lets
  // `ForumPostsService.vote` know when to mirror `voteCount` onto
  // `forum_thread.op_vote_count`. Set true when the OP is created (Wave 2) and
  // backfilled for existing threads by `AddForumOpDenormalization`.
  @Column({ type: 'boolean', default: false })
  isOp!: boolean;

  // Millisecond precision (not Postgres's microsecond default): matches the
  // resolution of the JS `Date` cursor `ForumPostsService.paginateOldestFirst`
  // builds from this column, so the raw column can be ordered/filtered on
  // directly instead of through a non-indexable `date_trunc(...)` wrapper —
  // see `1787600000000-NarrowForumPostCreatedAtPrecision.ts` and
  // `common/cursor-pagination.ts`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  // Soft-tombstone marker. When set, the post renders as "[deleted]" but the
  // `body` above is preserved so an author/moderator can restore it and its
  // edit history stays readable (see `ForumPostsService.tombstonePost`).
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  // WHO set the tombstone above. A platform moderator's takedown used to be
  // undoable by the author in one request, because delete and restore shared
  // the same author-OR-moderator check (BE-COM-01). Only the actor who set the
  // tombstone — or a platform Moderator/Admin — may clear it now; see
  // `ForumPostsService.assertCanRestore`. NULL is "not tombstoned" or a legacy
  // tombstone predating `AddContentTombstoneActor1793520000000`.
  @Column({ type: 'uuid', nullable: true })
  deletedById!: string | null;
}
