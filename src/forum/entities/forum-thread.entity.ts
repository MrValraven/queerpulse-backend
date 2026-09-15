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

  // What the thread IS: 'question', 'guide', 'proposal' or 'share'. The forum
  // carried all four shapes under one undifferentiated "thread" until the
  // richer composer (`AddForumRichComposer1817300000000`), which is why
  // `unanswered` had to be rescued once already (see `acceptedPostId` below): a
  // guide has no answer to accept, and a proposal's resolution is a decision
  // rather than a reply.
  //
  // NULL means "unclassified", which is every thread written before the
  // composer asked the question — stamping them all 'question' would print a
  // guess on the card as a fact. varchar rather than a Postgres enum, matching
  // `category`/`tags`: the vocabulary is expected to grow, and growing it
  // should be a product decision, not a migration.
  @Column({ type: 'varchar', length: 16, nullable: true })
  kind!: string | null;

  // Author-chosen labels warning a reader what is inside before they read it,
  // picked from a fixed list the composer offers (the list is application-side,
  // the same contract `tags` has). Array rather than a join table for the same
  // reason `tags` is one: a handful of short labels, read on every render of
  // the thread and never queried across threads.
  //
  // NOT NULL with a `'{}'` default, so "no warnings" is an empty array
  // everywhere and no read path branches on NULL. No GIN index, unlike `tags`:
  // nothing filters or browses BY a content warning.
  @Column({ type: 'text', array: true, default: () => "'{}'" })
  contentWarnings!: string[];

  // Masks the BYLINE only. `authorId` above stays the real member, untouched,
  // so ownership, `canEdit`, moderation, reports and the recognition/XP signals
  // all keep working against a real account — the same split `isOfficial`
  // already uses, and it matters more here: an anonymous thread is exactly the
  // kind that draws a report, and a report that cannot reach an actor is not
  // actionable. Anonymity is a rendering decision, never a gap in the record.
  @Column({ type: 'boolean', default: false })
  isAnonymous!: boolean;

  // A second member credited on the thread, for the guides and proposals two
  // people actually wrote together. NULL is the ordinary single-author case.
  //
  // The migration-owned FK is `ON DELETE SET NULL`, not CASCADE: a co-author
  // erasing their account must not take somebody else's thread down with it, so
  // the credit is dropped and the thread stands. That SET NULL is also why
  // `IDX_forum_thread_co_author_id` exists — the action has to find every
  // referencing row when a user row goes, and unindexed it scans the whole
  // thread table per deleted account (same argument as
  // `IDX_event_photos_uploader_id`).
  @Index('IDX_forum_thread_co_author_id')
  @Column({ type: 'uuid', nullable: true })
  coAuthorId!: string | null;

  // When the thread became visible, which stops being "when it was created" the
  // moment the composer can schedule. Backfilled to `created_at` for every
  // pre-existing row by `AddForumRichComposer1817300000000` and only then set
  // NOT NULL: for a thread written before scheduling existed, published and
  // created ARE the same instant, and a nullable column would push a NULL check
  // into every browse predicate forever.
  //
  // NO database default, deliberately — a `DEFAULT now()` would silently
  // publish a scheduled thread the moment an insert forgot to name the column,
  // and "now" is the one value this must never invent. Every write path sets it
  // explicitly.
  //
  // Member-facing reads gate on `published_at <= now()`. That predicate cannot
  // live in an index predicate (`now()` is STABLE, and index predicates must be
  // IMMUTABLE), so it is a filter on already-seeked rows; the rows it removes
  // are the scheduled-future tail, which clusters at the newest end of both
  // sorts. Millisecond precision matches `createdAt`/`lastActivityAt`, so a
  // future keyset on this column needs no `date_trunc()` wrapper.
  @Column({ type: 'timestamptz', precision: 3 })
  publishedAt!: Date;

  // 'pending' / 'approved' / 'rejected' — and NULL, which means NEVER SUBMITTED
  // FOR REVIEW and is the state of every thread that existed before this
  // column. That distinction is load-bearing: the forum is not becoming a
  // moderated-by-default surface, so NULL reads as "visible, nobody asked for
  // review" and not as "unreviewed, therefore hidden". Only the kinds that opt
  // in (a guide going to the editors, a proposal going to the council) ever
  // leave NULL.
  //
  // Member-facing reads gate on `review_state IS NULL OR review_state =
  // 'approved'`, and both partial keyset indexes below carry that disjunction.
  // It must be emitted VERBATIM, arm for arm: Postgres proves an OR predicate
  // by matching each query arm against a predicate arm, so a rewrite such as
  // `review_state IS DISTINCT FROM 'pending'` silently loses the index.
  @Column({ type: 'varchar', length: 12, nullable: true })
  reviewState!: string | null;

  // When this thread's CREATE FAN-OUT actually went out: the profile activity
  // event, the topics-directory link (and the topic-follow notifications behind
  // it), and the @mention notifications, whose payload carries the first 140
  // characters of the opening post as an excerpt.
  //
  // NULL means "owed, not sent yet", which is the state a thread is written in
  // when it is created scheduled (`publishedAt` in the future) or pending
  // review. Fanning out at create time for those two would put the excerpt in
  // front of other members before the thread was visible and, in the review
  // case, before a moderator had read it, which is the one thing pre-publish
  // review exists to prevent. So the fan-out is deferred and
  // `ForumThreadsService.publishThread` runs it the first time a read or a
  // write observes the thread has become visible, or when a moderator approves
  // it.
  //
  // It is also the IDEMPOTENCE mark, which is why it is durable rather than a
  // flag in memory: `publishThread` claims it with a single conditional
  // `UPDATE ... WHERE id = $1 AND fanned_out_at IS NULL` and fans out only when
  // that statement reports one affected row, so two concurrent readers of the
  // same newly-visible thread produce exactly one fan-out (see that method for
  // the full concurrency argument).
  //
  // Backfilled to `created_at` for every pre-existing row by
  // `AddForumThreadPublishLifecycle1817310000000`: those threads all fanned out
  // in the request that created them, and leaving them NULL would re-fire their
  // mentions years late on the first read.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  fannedOutAt!: Date | null;

  // A community thread (`communityId IS NOT NULL`) that its author also carried
  // out to the town square. Stored as its own flag rather than inferred,
  // because "which community wrote it" and "who gets to see it" are different
  // questions — a community thread without this stays where it was written.
  @Column({ type: 'boolean', default: false })
  crossPosted!: boolean;

  // The part of the city a thread is about, for the asks that only make sense
  // locally. Free text rather than a lookup table: neighbourhood names are
  // contested, overlapping and member-defined, and a curated list beside a
  // taxonomy nobody owns drifts. Unindexed — nothing browses by it yet.
  @Column({ type: 'varchar', length: 60, nullable: true })
  neighbourhood!: string | null;

  // After this instant the thread takes no new replies. Distinct from
  // `isLocked`/`lockReason`, which is a MODERATOR shutting a thread down; this
  // is the AUTHOR saying up front how long the question stays open (a poll that
  // ends, a call for volunteers with a deadline). Compared by the reply path at
  // write time, never by a scheduled job — a timestamp checked on write cannot
  // drift and needs nothing scheduled. NULL means the thread never auto-closes.
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  closesAt!: Date | null;

  // 'pt', 'en' or 'both'. Most readers have exactly one of the two, and a
  // Portuguese-only thread at the top of an English reader's list is a dead row
  // for them. NULL is "unstated", which is honest for the backlog: guessing
  // from the text would mislabel every short or mixed post.
  @Column({ type: 'varchar', length: 4, nullable: true })
  language!: string | null;

  // The reply this thread's author (or a platform moderator) marked as the
  // answer — a pointer into `forum_post`, null while the question is open.
  //
  // This is what makes the long-standing `unanswered` sort mean what its label
  // says: `ForumThreadsService.list` filters on `accepted_post_id IS NULL`,
  // where it used to filter on `reply_count = 0` (so a question with forty
  // replies and no resolution counted as answered). Backed by the partial
  // keyset index `IDX_forum_thread_visible_unanswered_created_at_id`, which
  // covers exactly the rows that sort can return — migration-owned, since a
  // partial DESC composite is not expressible as an `@Index` decorator. It
  // superseded the narrower `IDX_forum_thread_unanswered_created_at_id`
  // (partial on `accepted_post_id IS NULL` alone) in
  // `AddForumRichComposer1817300000000`, which folded the `deleted_at` and
  // review-state halves of the read gate into the predicate.
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
  // `IDX_forum_thread_visible_top_keyset` (`op_vote_count DESC,
  // last_activity_at DESC, id DESC`, `WHERE deleted_at IS NULL AND
  // (review_state IS NULL OR review_state = 'approved')`), built by
  // `AddForumRichComposer1817300000000` over the `WHERE deleted_at IS NULL`
  // version `AddForumThreadTopKeysetAndReplySearch` had built as
  // `IDX_forum_thread_top_keyset`. All three columns descend, matching
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
  // Every member-facing browse path carries `deleted_at IS NULL`, so the keyset
  // index that release added (`IDX_forum_thread_top_keyset`, since superseded
  // by `IDX_forum_thread_visible_top_keyset`) is partial on that predicate: it
  // then covers exactly the rows the sort can return, and shrinks rather than
  // grows as threads are withdrawn. The pre-existing
  // `created_at`/`last_activity_at` keyset indexes are left whole — they are
  // declared by `@Index` decorators (so a migration narrowing them would be
  // undone by the next `migration:generate` diff), they already serve their
  // ORDER BY, and there is no measurement saying the extra filter step costs
  // anything worth an index rebuild.
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
