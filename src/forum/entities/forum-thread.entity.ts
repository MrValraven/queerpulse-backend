import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A forum thread's metadata. Its opening post (the "OP") is *not* stored
 * here — it's the oldest `ForumPost` row for this thread (see
 * `ForumThreadsService.create`, which inserts both in one transaction).
 * Table name is singular (`forum_thread`) per the task brief, not pluralized
 * like `communities`/`community_posts`.
 */
@Entity('forum_thread')
@Index('IDX_forum_thread_created_at_id', ['createdAt', 'id'])
export class ForumThread {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_forum_thread_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Index('IDX_forum_thread_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  @Index('IDX_forum_thread_category')
  @Column({ type: 'varchar' })
  category!: string;

  // Optional link to the community this thread belongs to, so a community's
  // page can show its own forum threads. Null means the thread isn't tied to
  // a specific community.
  @Index('IDX_forum_thread_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId!: string | null;

  @Column({ type: 'boolean', default: false })
  isPinned!: boolean;

  @Column({ type: 'boolean', default: false })
  isLocked!: boolean;

  // Normalized (lowercase, deduped, `#`-stripped) free-text tags the author
  // attaches to a thread; drives the tag-filter chips in the frontend list.
  // Migration-owned GIN index (`IDX_forum_thread_tags`, see
  // `AddForumThreadTags`) backs `:tag = ANY(t.tags)` filtering — TypeORM's
  // `@Index` can't express an array/GIN operator class, so it lives in the
  // migration, not a decorator here (same precedent as
  // `1785700100000-AddSearchTrgmAndTagsIndexes.ts`'s `profiles.tags`).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  // Denormalized copy of the OP post's `voteCount`, kept in sync by
  // `ForumPostsService.vote` when the voted post `is_op`. Lets the thread-list
  // card render upvotes and the `top` sort order threads without joining
  // `forum_post` per row. Migration-owned keyset index
  // `IDX_forum_thread_op_vote_count_id` (`op_vote_count DESC, id DESC`) backs
  // that sort — the `id` tie-break is DESC (same direction as the leading
  // column) so it matches `cursorPaginate`'s ORDER BY; a full DESC composite,
  // so migration-only, not an `@Index` decorator.
  @Column({ type: 'int', default: 0 })
  opVoteCount!: number;

  // Count of *replies* only — the OP itself isn't counted (mirrors the
  // frontend's `ForumThreadResponse.replyCount`, which the thread list/detail
  // cards render next to a distinct "posts" affordance for the OP).
  @Column({ type: 'int', default: 0 })
  replyCount!: number;

  // Set at creation, bumped to `now()` on every new reply
  // (`ForumThreadsService.markActivity`) — drives "recently active" sort in
  // the frontend, independent of `createdAt`.
  //
  // Millisecond precision (`timestamptz(3)`, not Postgres's microsecond
  // default): the `active` keyset seeks on the raw column against a millisecond
  // cursor, so the stored value must round to the same resolution or a
  // same-millisecond row could fall through the page boundary — the same
  // argument as `createdAt` below. Narrowed in `AddForumOpDenormalization`,
  // which also builds the backing `IDX_forum_thread_last_activity_id`
  // (`last_activity_at DESC, id DESC`) keyset index.
  @Column({ type: 'timestamptz', precision: 3 })
  lastActivityAt!: Date;

  // Millisecond precision (not Postgres's microsecond default): matches the
  // resolution of the JS `Date` cursor `cursorPaginate` builds from this
  // column, so the raw column can be ordered/filtered on directly instead of
  // through a non-indexable `date_trunc(...)` wrapper — see
  // `1785001400000-NarrowCursorCreatedAtPrecision.ts` and
  // `common/cursor-pagination.ts`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
