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

  // Watermark: null = never pinned; a timestamp = pinned since then. Lets
  // multiple pinned threads order deterministically (`pinned_at DESC`) — same
  // pattern as `conversation_participants.pinned_at` (see
  // `AddConversationPinFavorite`). Set alongside `isPinned` in
  // `ForumThreadsService.setPinned`, never independently.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  pinnedAt!: Date | null;

  @Column({ type: 'boolean', default: false })
  isLocked!: boolean;

  // Optional moderator note explaining why the thread was closed (e.g.
  // "resolved", "off-topic"), set alongside `isLocked` by
  // `ForumThreadsService.setLocked`. Null when a lock carried no reason (every
  // lock cast before this column existed, or a moderator who left it blank),
  // in which case the locked banner falls back to its generic copy. Cleared
  // back to null on unlock — a fresh lock note, not an append-only log.
  @Column({ type: 'varchar', length: 280, nullable: true })
  lockReason!: string | null;

  // When true, the thread's author is displayed as "QueerPulse Official"
  // instead of the real poster (see `toForumThreadResponse`'s `author`
  // branch in `forum-response.ts`). `authorId` above is left untouched — it
  // stays the real admin who posted, so `canEdit`/ownership checks keep
  // working unchanged. Settable only by an admin: at creation via
  // `CreateThreadDto.isOfficial` (coerced server-side in
  // `ForumThreadsService.create`), or after the fact via
  // `ForumThreadsService.setOfficial` (`AdminForumController`).
  @Column({ type: 'boolean', default: false })
  isOfficial!: boolean;

  // Normalized (lowercase, deduped, `#`-stripped) free-text tags the author
  // attaches to a thread; drives the tag-filter chips in the frontend list.
  // Migration-owned GIN index (`IDX_forum_thread_tags`, see
  // `AddForumThreadTags`) backs `:tag = ANY(t.tags)` filtering — TypeORM's
  // `@Index` can't express an array/GIN operator class, so it lives in the
  // migration, not a decorator here (same precedent as
  // `1785700100000-AddSearchTrgmAndTagsIndexes.ts`'s `profiles.tags`).
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  tags!: string[];

  // The reply this thread's author (or a platform moderator) marked as the
  // answer — a pointer into `forum_post`, null while the question is open.
  //
  // This is what makes the long-standing `unanswered` sort mean what its label
  // says: `ForumThreadsService.list` filters on `accepted_post_id IS NULL`,
  // where it used to filter on `reply_count = 0` (so a question with forty
  // replies and no resolution counted as answered). Backed by the partial
  // keyset index `IDX_forum_thread_unanswered_created_at_id`, which covers
  // exactly the rows that sort can return — migration-owned, since a partial
  // DESC composite is not expressible as an `@Index` decorator.
  //
  // `ON DELETE SET NULL` on the FK: a hard-deleted post clears the mark and
  // leaves the thread standing. A soft tombstone never reaches the FK, so
  // `setAcceptedPost` refuses to mark a tombstoned post and the read path drops
  // the mark from a post tombstoned after the fact.
  @Column({ type: 'uuid', nullable: true })
  acceptedPostId!: string | null;

  // Denormalized copy of the OP post's `voteCount`, kept in sync by
  // `ForumPostsService.vote` when the voted post `is_op`. Lets the thread-list
  // card render upvotes and the `top` sort order threads without joining
  // `forum_post` per row.
  //
  // The `top` sort's backing index is the migration-owned
  // `IDX_forum_thread_top_keyset` (`op_vote_count DESC, last_activity_at DESC,
  // id DESC`, `WHERE deleted_at IS NULL`), built by
  // `AddForumThreadTopKeysetAndReplySearch`. All three columns descend, matching
  // the ORDER BY `ForumThreadsService.paginateTop` emits, and the middle column
  // is what stops a forum full of zero-vote threads from coming back in uuid
  // order: `op_vote_count DESC, id DESC` alone (the older
  // `IDX_forum_thread_op_vote_count_id`) tie-broke on a random uuid, so on a
  // young forum the landing page was a shuffle that never changed as people
  // posted (PRD-161). A full DESC composite with a partial predicate is not
  // expressible as an `@Index` decorator, so it lives in the migration.
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

  // Thread-level soft delete (PRD-160).
  //
  // Deliberately NOT the same thing as the opening post's own tombstone
  // (`ForumPost.deletedAt`). Deleting the OP used to leave the THREAD standing:
  // a member who withdrew a housing ask or a health question they regretted
  // still had its full title on /forum, in every member's feed and behind a
  // live link, with only the body blanked. Withdrawing the question has to
  // withdraw the question. A stamped `deleted_at` takes the whole thread out of
  // every browse, count, pinned bucket, search and detail read, for everyone
  // except platform staff, who keep seeing it so a report filed against it
  // stays actionable and an appeal has something to look at.
  //
  // Soft, never a row delete: the replies underneath are other people's words
  // and stay intact (`ForumThreadsService.deleteThread` touches only the OP),
  // and moderation history that points at this thread must not dangle.
  //
  // Every member-facing browse path carries `deleted_at IS NULL`, so the ONE
  // new keyset index this release adds (`IDX_forum_thread_top_keyset`) is
  // partial on that predicate: it then covers exactly the rows the sort can
  // return, and shrinks rather than grows as threads are withdrawn. The
  // pre-existing `created_at`/`last_activity_at` keyset indexes are left whole
  // — they already serve their ORDER BY and there is no measurement saying the
  // extra filter step costs anything worth an index rebuild.
  @Column({ type: 'timestamptz', nullable: true })
  deletedAt!: Date | null;

  // WHO deleted the thread: its own author withdrawing it, or the platform
  // moderator who took it down. The same split `ForumPost.deletedById` records
  // and for the same reason (see `AddContentTombstoneActor`): "the author
  // withdrew this" and "staff removed this" are different facts, and an appeal
  // has to be able to tell them apart. NULL means the thread is not deleted.
  @Column({ type: 'uuid', nullable: true })
  deletedById!: string | null;
}
