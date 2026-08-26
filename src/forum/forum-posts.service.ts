import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository, SelectQueryBuilder } from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { CursorPage, cursorPaginate } from '../common/cursor-pagination';
import { MemberLookup } from '../common/member-ref';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumThreadsService } from './forum-threads.service';
import { AccessTier } from '../communities/entities/community.entity';
import {
  FORUM_POST_SEARCH_FIELDS,
  foldSearchText,
  foldedSearchQuery,
  weightedSearchVector,
} from '../search/search-text';
import {
  ForumPostHistoryResponse,
  ForumPostResponse,
  ForumPostViewer,
  toForumPostHistoryEntry,
  toForumPostResponse,
} from './forum-response';

const DEFAULT_LIMIT = 20;

/** How many characters of a matching reply the search card shows. */
const SEARCH_EXCERPT_LENGTH = 160;

/**
 * One reply-body hit for global search (SOC-08). Carries the THREAD's slug and
 * title, because that is where the card links and what a member recognises:
 * the post itself has no page of its own. `excerpt` is the part of the reply
 * that matched.
 */
export interface ForumPostSearchRow {
  threadSlug: string;
  threadTitle: string;
  threadCategory: string;
  excerpt: string;
}

interface ForumPostSearchRawRow {
  threadSlug: string;
  threadTitle: string;
  threadCategory: string;
  postBody: string;
}

/**
 * A short window of `body` around the first place `term` matches, so the card
 * shows the sentence that answered the question instead of whatever the reply
 * happened to open with. Falls back to the head of the body when the match came
 * from stemming/tokenisation rather than a literal substring.
 */
function buildSearchExcerpt(body: string, term: string): string {
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length <= SEARCH_EXCERPT_LENGTH) return collapsed;
  const matchIndex = foldSearchText(collapsed).indexOf(foldSearchText(term));
  if (matchIndex < 0)
    return `${collapsed.slice(0, SEARCH_EXCERPT_LENGTH)}\u2026`;
  const start = Math.max(0, matchIndex - Math.floor(SEARCH_EXCERPT_LENGTH / 3));
  const window = collapsed.slice(start, start + SEARCH_EXCERPT_LENGTH);
  return `${start > 0 ? '\u2026' : ''}${window}${start + SEARCH_EXCERPT_LENGTH < collapsed.length ? '\u2026' : ''}`;
}

export interface VoteResult {
  voteCount: number;
  myVote: number;
}

const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

function isModeratorRole(role: string): boolean {
  return MODERATOR_ROLES.includes(role);
}

function viewerOf(user: CurrentUserData): ForumPostViewer {
  return { userId: user.userId, isModerator: isModeratorRole(user.role) };
}

@Injectable()
export class ForumPostsService {
  constructor(
    @InjectRepository(ForumPost)
    private readonly posts: Repository<ForumPost>,
    @InjectRepository(ForumPostVote)
    private readonly votes: Repository<ForumPostVote>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    private readonly threadsService: ForumThreadsService,
    private readonly blockFilter: BlockFilterService,
    @InjectRepository(ForumPostEdit)
    private readonly edits: Repository<ForumPostEdit>,
    private readonly mentions: MentionNotificationService,
    private readonly contentModeration: ContentModerationService,
    // SOC-13 — thread following: auto-subscribe the replier and fan a new
    // reply out to everyone else already following the thread.
    private readonly subscriptions: ForumSubscriptionsService,
  ) {}

  // A forum post can be reported (and thus taken down) under either taxonomy
  // code — the thread OP reports as `post`, a nested comment as `reply` — both
  // keyed by the post's uuid. Reads check both.
  private static readonly SUBJECT_TYPES = ['post', 'reply'];

  // Backs the `hasPosted` flag on `GET /forum/threads/counts` (see
  // `ForumController.threadCounts`) — a cheap EXISTS check, backed by
  // `IDX_forum_post_author_id`, for "has this member ever posted." A thread's
  // opening post is itself a `forum_post` row (`ForumThreadsService.create`
  // inserts it alongside the thread), so this single check covers both thread
  // authorship and replies — no separate thread-table lookup needed.
  async hasEverPosted(userId: string): Promise<boolean> {
    return this.posts.exists({ where: { authorId: userId } });
  }

  /**
   * Cross-entity global search over REPLY BODIES (SOC-08). Before this, forum
   * search read thread titles only, so "has anyone found a trans-friendly GP in
   * Lisbon?" was unanswerable: the answer was always in a reply.
   *
   * Full text only, no substring branch. Post bodies were not searchable at all
   * before this, so there is no `ILIKE` behaviour to preserve, and a GIN trigram
   * index over long bodies is by far the most expensive index the search work
   * would have added. See `1795100000000-AddSearchTextIndexes`.
   *
   * Visibility is enforced entirely in-query, and this method is the one place
   * post bodies escape a thread page, so every gate a thread page applies is
   * re-applied here:
   *
   *  - the post's author is not blocked either way, and not muted by the viewer
   *    (`BlockFilterService.excludeHidden`, same as `listPosts`);
   *  - the THREAD's author is not blocked or muted either — `ForumThreadsService.list`
   *    hides those threads, so a reply inside one must not be a side door back in;
   *  - the thread's community is public/request/invite, or the viewer is on a
   *    Private community's roster (the same H1 gate as thread search);
   *  - the post is not tombstoned (`deleted_at`), whose body is retained only so
   *    a moderator can restore it;
   *  - the post is not hidden OR removed by moderation. Read paths keep a
   *    removed post as a visible `[removed]` tombstone; search must not, because
   *    surfacing it means surfacing the text a moderator took down.
   */
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
    offset = 0,
  ): Promise<ForumPostSearchRow[]> {
    const searchVector = weightedSearchVector('p', FORUM_POST_SEARCH_FIELDS);
    const searchTsQuery = foldedSearchQuery('searchTerm');
    const qb = this.posts
      .createQueryBuilder('p')
      .select('t.slug', 'threadSlug')
      .addSelect('t.title', 'threadTitle')
      .addSelect('t.category', 'threadCategory')
      .addSelect('p.body', 'postBody')
      .innerJoin(ForumThread, 't', 't.id = p.threadId')
      .where(`${searchVector} @@ ${searchTsQuery}`, { searchTerm: term })
      // A tombstoned post keeps its body for restore; it is not content.
      .andWhere('p.deletedAt IS NULL');

    // Post author: blocked either way, or muted by the viewer.
    this.blockFilter.excludeHidden(qb, viewerId, '"p"."author_id"');

    // Thread author: same rule, expressed inline because `excludeHidden` binds
    // one fixed parameter name and can only be called once per query builder.
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "blocks" "__thread_author_block"
        WHERE ("__thread_author_block"."blocker_id" = :searchViewerId AND "__thread_author_block"."blocked_id" = "t"."author_id")
           OR ("__thread_author_block"."blocked_id" = :searchViewerId AND "__thread_author_block"."blocker_id" = "t"."author_id")
      )
      AND NOT EXISTS (
        SELECT 1 FROM "mutes" "__thread_author_mute"
        WHERE "__thread_author_mute"."muter_id" = :searchViewerId
          AND "__thread_author_mute"."muted_id" = "t"."author_id"
      )`,
      { searchViewerId: viewerId },
    );

    // Private-community gate, mirroring `ForumThreadsService.applyCommunityAccessFilter`.
    qb.andWhere(
      `(
        "t"."community_id" IS NULL
        OR EXISTS (
          SELECT 1 FROM "communities" "__search_com"
          WHERE "__search_com"."id" = "t"."community_id"
            AND "__search_com"."access_tier" != :searchPrivateTier
        )
        OR EXISTS (
          SELECT 1 FROM "community_members" "__search_mem"
          WHERE "__search_mem"."community_id" = "t"."community_id"
            AND "__search_mem"."user_id" = :searchViewerId
        )
      )`,
      { searchPrivateTier: AccessTier.Private },
    );

    // Moderation takedowns, both kinds. `ContentModerationService.excludeHidden`
    // drops hidden-but-not-removed only; search additionally drops removed, so
    // this is written out rather than delegated.
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "__search_moderation"
        WHERE "__search_moderation"."subject_type" IN (:...searchModerationSubjectTypes)
          AND "__search_moderation"."subject_id" = "p"."id"::text
          AND ("__search_moderation"."hidden_at" IS NOT NULL OR "__search_moderation"."removed_at" IS NOT NULL)
      )`,
      { searchModerationSubjectTypes: ForumPostsService.SUBJECT_TYPES },
    );

    // Relevance first, newest reply as the tiebreaker. The rank alias is
    // dot-free so TypeORM's ORDER BY re-parse leaves it alone. Several replies
    // in one thread can each match; they stay as separate cards, because their
    // excerpts are what differ and each is a distinct answer.
    const rows = await qb
      .addSelect(`ts_rank(${searchVector}, ${searchTsQuery})`, 'search_rank')
      .orderBy('search_rank', 'DESC')
      .addOrderBy('p.created_at', 'DESC')
      .limit(limit)
      .offset(offset)
      .getRawMany<ForumPostSearchRawRow>();

    return rows.map((row) => ({
      threadSlug: row.threadSlug,
      threadTitle: row.threadTitle,
      threadCategory: row.threadCategory,
      excerpt: buildSearchExcerpt(row.postBody ?? '', term),
    }));
  }

  // GET /forum/threads/:slug/posts?cursor= — OP + replies, oldest-first.
  // `cursorPaginate`'s default keyset is hard-wired to a newest-first
  // `(createdAt, id) DESC` ordering, which doesn't fit this endpoint's
  // contract ("OP is the first post, oldest-first" — see forum.api.ts).
  // `paginateOldestFirst` below still goes through `cursorPaginate`, but via
  // its alternate-keyset path (`CursorKeyset`) so it can swap in an ASC
  // direction on the raw `created_at` column. `ForumPost.createdAt` is
  // `timestamptz(3)` (see
  // `1787600000000-NarrowForumPostCreatedAtPrecision.ts`), so the raw column
  // already matches the millisecond-resolution cursor and needs no
  // `date_trunc(...)` wrapper — ordering/filtering rides
  // `IDX_forum_post_thread_id_created_at_id` directly instead of forcing a
  // Sort on every page.
  async listPosts(
    threadSlug: string,
    user: CurrentUserData,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumPostResponse>> {
    const thread = await this.threadsService.loadOr404(threadSlug, user.userId);

    const acceptedPostId = thread.acceptedPostId;

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.threadId = :threadId', { threadId: thread.id });
    // The accepted answer is lifted OUT of the ordinary oldest-first stream and
    // re-inserted at the top of the first page below, so it is never rendered
    // twice across a "Load more" session. Excluding it on every page (not just
    // the first) is what makes that safe: the cursor keyset stays a plain
    // `(created_at, id)` seek, which an `ORDER BY (id = :accepted) DESC, ...`
    // could not be. This is the server-side ordering that replaces the old
    // client-side "most helpful" heuristic, which only ever ranked the replies
    // that happened to have loaded (SOC-13).
    if (acceptedPostId) {
      qb.andWhere('p.id != :acceptedPostId', { acceptedPostId });
    }
    // Posts by a blocked (either way) or muted author are dropped in-query, so
    // the keyset page below fills to `limit` with visible posts instead of
    // coming back short (see `BlockFilterService.excludeHidden`). NB: this can
    // hide the OP itself when the thread author is only *muted* — a muted
    // author's thread is still reachable by direct navigation (see
    // `ForumThreadsService.loadOr404`), but their posts stay silenced, which is
    // exactly what a mute means.
    this.blockFilter.excludeHidden(qb, user.userId, '"p"."author_id"');

    const { rows, nextCursor, hasMore } = await this.paginateOldestFirst(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      'p',
    );

    const orderedRows =
      cursor || !acceptedPostId
        ? rows
        : await this.hoistAcceptedPost(rows, acceptedPostId, user);

    return {
      data: await this.toPostResponses(orderedRows, user, acceptedPostId),
      pageInfo: { nextCursor, hasMore },
    };
  }

  /**
   * Puts the thread's accepted answer at the top of the FIRST page of replies,
   * immediately after the opening post.
   *
   * Runs only when there is no cursor (page one) — `listPosts` has already
   * excluded the accepted post from the paginated stream, so this is the single
   * place it enters the response. The post goes through the same block/mute
   * filter as every other row: an accepted answer written by someone the viewer
   * has since blocked or muted stays hidden, exactly as it would in the stream.
   *
   * Index 1, not 0: the frontend contract is "the first post of the first page
   * is the OP" (`threadDetail` destructures it that way), so the answer slots
   * in behind it. If the first row is not the OP — a thread whose author the
   * viewer has muted, so the OP itself was filtered out — the answer leads.
   */
  private async hoistAcceptedPost(
    rows: ForumPost[],
    acceptedPostId: string,
    user: CurrentUserData,
  ): Promise<ForumPost[]> {
    const acceptedQb = this.posts
      .createQueryBuilder('p')
      .where('p.id = :acceptedPostId', { acceptedPostId });
    this.blockFilter.excludeHidden(acceptedQb, user.userId, '"p"."author_id"');
    const accepted = await acceptedQb.getOne();
    if (!accepted) return rows;
    const insertAt = rows[0]?.isOp ? 1 : 0;
    return [...rows.slice(0, insertAt), accepted, ...rows.slice(insertAt)];
  }

  // Resolves each post's moderation state and applies the read policy: a member
  // never sees a hidden post (dropped from the page), a moderator sees every
  // post flagged, and a removed post is kept but rendered as a tombstone by
  // `toForumPostResponse`. Returns the surviving rows paired with their state.
  private async partitionByModeration(
    rows: ForumPost[],
    viewer: ForumPostViewer,
  ): Promise<Array<{ post: ForumPost; moderation: ContentModerationState }>> {
    if (!rows.length) return [];
    const states = await this.contentModeration.statesForAnyType(
      ForumPostsService.SUBJECT_TYPES,
      rows.map((post) => post.id),
    );
    const visible: Array<{
      post: ForumPost;
      moderation: ContentModerationState;
    }> = [];
    for (const post of rows) {
      const moderation = states.get(post.id) ?? {
        hidden: false,
        removed: false,
      };
      // A hidden-but-not-removed post is withheld from ordinary members; a
      // removed post survives as a tombstone for everyone.
      if (moderation.hidden && !moderation.removed && !viewer.isModerator) {
        continue;
      }
      visible.push({ post, moderation });
    }
    return visible;
  }

  // POST /forum/threads/:slug/posts — a reply (never the OP, which is
  // created alongside the thread by `ForumThreadsService.create`). An
  // optional `parentPostId` nests this reply under another post in the same
  // thread (a top-level comment on the thread otherwise) — see
  // `ForumPost.parentPostId`'s docstring.
  async reply(
    threadSlug: string,
    user: CurrentUserData,
    body: string,
    parentPostId?: string,
    image?: string,
  ): Promise<ForumPostResponse> {
    // Passing the replier as viewer 404s the thread when its author is blocked
    // either way — a block is a hard severance, so it has to gate the write
    // path too, not just the reads above.
    const thread = await this.threadsService.loadOr404(threadSlug, user.userId);
    // A community-scoped thread takes replies from that community's roster
    // only — same rule `ForumThreadsService.create` applies to starting one
    // (BE-COM-05). `loadOr404` above has already 404'd a Private community's
    // thread for a non-member; this covers the request/invite tiers, whose
    // threads are readable platform-wide but still not writable by outsiders.
    await this.threadsService.assertCanReplyInThread(thread, user.userId);
    if (thread.isLocked) {
      throw new ForbiddenException('This thread is locked');
    }

    const parentPost = parentPostId
      ? await this.loadReplyParentOr400(parentPostId, thread.id)
      : null;

    // One transaction so the reply insert and the parent thread's
    // `replyCount` bump (+ `lastActivityAt` refresh, via `markActivity`)
    // commit together — a crash between the two separate writes previously
    // drifted the denormalized count.
    const saved = await this.posts.manager.transaction(async (manager) => {
      const created = await manager.save(
        manager.create(ForumPost, {
          threadId: thread.id,
          authorId: user.userId,
          body,
          image: image ?? null,
          voteCount: 0,
          // A reply is never the OP — that's created alongside the thread in
          // `ForumThreadsService`. Set explicitly (the entity default is also
          // false) so the invariant is visible at the call site and a voted
          // reply never mirrors onto `forum_thread.op_vote_count`.
          isOp: false,
          parentPostId: parentPost?.id ?? null,
        }),
      );
      await this.threadsService.markActivity(thread.id, manager);
      // SOC-13 — replying IS following: the member has committed to this
      // conversation, so the rest of it should reach them. Idempotent, and
      // inside the reply's own transaction so a follow can never survive a
      // rolled-back reply.
      await this.subscriptions.subscribe(thread.id, user.userId, manager);
      return created;
    });

    const mentionNotifiedUserIds = await this.mentions.notify(
      body,
      user.userId,
      {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
        excerpt: body.slice(0, 140),
      },
    );

    // Notify the parent post's author that their comment got a reply, via its
    // own `ForumReply` notification type — see
    // `MentionNotificationService.notifyParentReply` for the payload shape and
    // the self-reply skip. Skipped when the reply body already `@mentioned`
    // the parent author by name — `notify()` above will have already created
    // a Mention notification for them, and firing this one too would double-
    // notify/double-push the same person for the same reply.
    if (parentPost && !mentionNotifiedUserIds.has(parentPost.authorId)) {
      await this.mentions.notifyParentReply(parentPost.authorId, user.userId, {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
        parentPostId: parentPost.id,
        excerpt: body.slice(0, 140),
      });
    }

    // A *top-level* reply (no parent post) is a reply to the thread itself —
    // notify the thread's original author with its own `ForumThreadReply` type.
    // Same de-dupe as the parent-reply case: skipped when the reply already
    // `@mentioned` the thread author, so they're never double-notified.
    if (!parentPost && !mentionNotifiedUserIds.has(thread.authorId)) {
      await this.mentions.notifyThreadReply(thread.authorId, user.userId, {
        actorId: user.userId,
        source: 'forum',
        threadSlug,
        postId: saved.id,
        excerpt: body.slice(0, 140),
      });
    }

    // SOC-13 — everyone ELSE following this thread. The three notifies above
    // are the targeted ones (mentioned members, the parent post's author, the
    // thread's author); this is the open subscription. `alreadyNotified` is
    // what keeps a follower who is also one of those three from being told
    // about the same reply twice.
    const alreadyNotified = new Set(mentionNotifiedUserIds);
    if (parentPost) alreadyNotified.add(parentPost.authorId);
    if (!parentPost) alreadyNotified.add(thread.authorId);
    await this.notifySubscribers(
      thread,
      saved.id,
      user.userId,
      alreadyNotified,
    );

    const authors = await new MemberLookup(this.profiles).byUserIds([
      user.userId,
    ]);
    return toForumPostResponse(
      saved,
      authors.get(user.userId) ?? null,
      0,
      viewerOf(user),
      undefined,
      thread.acceptedPostId,
    );
  }

  /**
   * Tells a thread's followers about a new reply, reusing the EXISTING
   * `forum_thread_reply` notification type rather than minting a new one: the
   * bell copy, the deep link, the push handling and the preference category are
   * all already wired for "someone replied in this thread", and a follower is
   * asking for exactly that signal. No notification-type migration (SOC-13).
   *
   * `alreadyNotified` carries the recipients the targeted notifies above have
   * already covered, so nobody is told twice about one reply. Block and mute
   * are enforced one level down, inside `NotificationsService.create`, which
   * drops a notification whose actor the recipient has hidden.
   *
   * Best-effort throughout: `notifyThreadReply` swallows its own failures, and
   * the reply has already committed by the time this runs.
   */
  private async notifySubscribers(
    thread: ForumThread,
    postId: string,
    actorId: string,
    alreadyNotified: Set<string>,
  ): Promise<void> {
    const subscriberIds = await this.subscriptions.subscriberIdsToNotify(
      thread.id,
      actorId,
    );
    for (const subscriberId of subscriberIds) {
      if (alreadyNotified.has(subscriberId)) continue;
      await this.mentions.notifyThreadReply(subscriberId, actorId, {
        actorId,
        source: 'forum',
        threadSlug: thread.slug,
        postId,
      });
    }
  }

  // POST /forum/posts/:id/vote — `value` is +1 (upvote) or 0 (remove vote).
  // Idempotent both ways: voting +1 twice or removing an absent vote is a
  // no-op rather than double-counting/going negative.
  //
  // Concurrency-safe by construction: the whole toggle runs in one
  // transaction, the insert is `ON CONFLICT DO NOTHING` (`.orIgnore()`) so a
  // racing duplicate upvote can't raise a 23505 unique violation, and the
  // denormalized `voteCount` is only moved via SQL-level atomic
  // increment/decrement (`voteCount = voteCount + 1`) — never a
  // read-modify-write, which would lose updates under concurrent votes. The
  // counter is touched *only* when a row is genuinely inserted/deleted (the
  // insert's `RETURNING` row / the delete's `affected` count), so the two
  // idempotent no-op paths leave it untouched.
  //
  // When the voted post is the thread's OP (`is_op`), the thread's
  // denormalized `op_vote_count` is mirrored to the post's *post-toggle*
  // `voteCount` in the SAME transaction, so the thread-list card and the OP
  // post never diverge (and the `top` keyset sort stays correct). The mirror
  // is an assignment to the freshly-read count — not an independent
  // increment — so it self-heals any prior drift and stays exactly consistent
  // with the value this call returns. The atomic `voteCount` increment above
  // holds the post's row lock, which serializes concurrent OP votes, so the
  // last committer writes the final count to both places.
  async vote(
    postId: string,
    userId: string,
    value: number,
  ): Promise<VoteResult> {
    return this.posts.manager.transaction(async (manager) => {
      const post = await manager.findOne(ForumPost, { where: { id: postId } });
      if (!post) {
        throw new NotFoundException('Post not found');
      }

      if (value === 1) {
        const inserted = await manager
          .createQueryBuilder()
          .insert()
          .into(ForumPostVote)
          .values({ postId, userId, value: 1 })
          .orIgnore()
          .execute();
        // On conflict the row is skipped and no `RETURNING` row comes back;
        // only bump the count when this call is the one that inserted.
        const insertedRows = inserted.raw as unknown[];
        if (insertedRows.length > 0) {
          await manager.increment(ForumPost, { id: postId }, 'voteCount', 1);
        }
      } else if (value === 0) {
        const deleted = await manager.delete(ForumPostVote, { postId, userId });
        if (deleted.affected && deleted.affected > 0) {
          await manager.decrement(ForumPost, { id: postId }, 'voteCount', 1);
        }
      }

      // Re-read inside the transaction so the returned count reflects this
      // toggle (and any other votes committed before our row lock).
      const refreshed = await manager.findOne(ForumPost, {
        where: { id: postId },
      });
      const voteCount = refreshed?.voteCount ?? post.voteCount;

      // Mirror the OP's count onto its thread's denormalized `op_vote_count`
      // within this same transaction, so both commit together. Guarded on
      // `is_op` so ordinary replies never touch the thread row.
      if (post.isOp) {
        await manager.update(
          ForumThread,
          { id: post.threadId },
          { opVoteCount: voteCount },
        );
      }

      return {
        voteCount,
        myVote: value,
      };
    });
  }

  // PATCH /forum/posts/:id — author-only body edit. Snapshots the pre-edit
  // body to `forum_post_edit`, stamps `editedAt`.
  async updatePostBody(
    postId: string,
    user: CurrentUserData,
    body: string,
    image?: string,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    if (post.deletedAt) {
      throw new NotFoundException('Post not found');
    }
    if (post.authorId !== user.userId) {
      throw new ForbiddenException('Only the author can edit this post');
    }

    // Snapshot the pre-edit body and persist the new one atomically: a partial
    // failure between the two writes would otherwise record a "previous body"
    // for an edit that never landed (a phantom revision).
    const previousBody = post.body;
    post.body = body;
    // Omitted leaves the existing photo alone; an explicit empty string clears
    // it. `forum_post_edit` snapshots the body only, so an image swap is not
    // itself a revision — same as `community_post_edit`.
    if (image !== undefined) {
      post.image = image === '' ? null : image;
    }
    post.editedAt = new Date();
    await this.posts.manager.transaction(async (manager) => {
      await manager.save(
        manager.create(ForumPostEdit, {
          postId: post.id,
          previousBody,
          previousTitle: null,
          editorId: user.userId,
        }),
      );
      await manager.save(post);
    });

    return this.mapOne(post, user);
  }

  // DELETE /forum/posts/:id — soft tombstone. Author or platform staff.
  async tombstonePost(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);
    if (!post.deletedAt) {
      post.deletedAt = new Date();
      // Stamped with the marker so `assertCanRestore` can tell an author's own
      // delete apart from a moderator takedown (BE-COM-01).
      post.deletedById = user.userId;
      await this.posts.save(post);
      // A tombstoned post is no longer an answer. The FK only clears on a HARD
      // delete, so the soft-delete path has to release the mark itself, leaving
      // the thread genuinely unanswered again rather than pointing at an empty
      // tombstone (SOC-13).
      await this.posts.manager.update(
        ForumThread,
        { id: post.threadId, acceptedPostId: post.id },
        { acceptedPostId: null },
      );
    }
    return this.mapOne(post, user);
  }

  // POST /forum/posts/:id/restore — clear the tombstone. Only the actor who
  // set it, or a platform Moderator/Admin (see `assertCanRestore`).
  async restorePost(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);
    this.assertCanRestore(post, user);
    if (post.deletedAt) {
      post.deletedAt = null;
      // Cleared with the marker so a later delete/restore pair is judged on
      // its own actor, never a stale one.
      post.deletedById = null;
      await this.posts.save(post);
    }
    return this.mapOne(post, user);
  }

  // GET /forum/posts/:id/history — revisions, newest-first. Author or staff.
  async listHistory(
    postId: string,
    user: CurrentUserData,
  ): Promise<ForumPostHistoryResponse> {
    const post = await this.loadPostOr404(postId);
    this.assertCanModerate(post, user);

    const rows = await this.edits.find({
      where: { postId },
      order: { createdAt: 'DESC' },
    });
    const editorIds = [
      ...new Set(
        rows.map((row) => row.editorId).filter((id): id is string => !!id),
      ),
    ];
    const editors = await new MemberLookup(this.profiles).byUserIds(editorIds);

    return {
      revisions: rows.map((row) =>
        toForumPostHistoryEntry(
          row,
          row.editorId ? (editors.get(row.editorId) ?? null) : null,
        ),
      ),
    };
  }

  private assertCanModerate(post: ForumPost, user: CurrentUserData): void {
    if (post.authorId !== user.userId && !isModeratorRole(user.role)) {
      throw new ForbiddenException(
        'Only the author or a moderator can do that',
      );
    }
  }

  /**
   * Restore authz, on top of `assertCanModerate`'s author-or-moderator gate.
   *
   * A tombstone may only be cleared by the actor who SET it, or by a platform
   * Moderator/Admin. Delete and restore previously shared `assertCanModerate`
   * outright, so a moderator's `DELETE /forum/posts/:id` was undone by the
   * author's `POST /forum/posts/:id/restore` in the very next request —
   * exactly the rule `toForumPostResponse` already documented ("Only an
   * author's own tombstone is restorable through the forum route") but nothing
   * enforced (BE-COM-01).
   *
   * A null `deletedById` is the legacy case (a tombstone written before
   * `AddContentTombstoneActor1793520000000`, or no tombstone at all, where
   * restore is a no-op) — it falls through to `assertCanModerate`'s rule
   * rather than locking legacy content out of restore.
   */
  private assertCanRestore(post: ForumPost, user: CurrentUserData): void {
    if (isModeratorRole(user.role)) return;
    if (post.deletedById === null) return;
    if (post.deletedById !== user.userId) {
      throw new ForbiddenException(
        'Only a moderator can restore a post a moderator removed',
      );
    }
  }

  private async loadPostOr404(postId: string): Promise<ForumPost> {
    const post = await this.posts.findOne({ where: { id: postId } });
    if (!post) {
      throw new NotFoundException('Post not found');
    }
    return post;
  }

  // Validates a reply's `parentPostId` before it's persisted: the parent must
  // exist, belong to the *same* thread (a nested reply can't point across
  // threads), and not be a tombstone (no replying to a deleted post).
  private async loadReplyParentOr400(
    parentPostId: string,
    threadId: string,
  ): Promise<ForumPost> {
    const parent = await this.posts.findOne({ where: { id: parentPostId } });
    if (!parent) {
      throw new NotFoundException('Parent post not found');
    }
    if (parent.threadId !== threadId) {
      throw new BadRequestException(
        'Parent post does not belong to this thread',
      );
    }
    if (parent.deletedAt) {
      throw new BadRequestException('Cannot reply to a deleted post');
    }
    return parent;
  }

  private async mapOne(
    post: ForumPost,
    user: CurrentUserData,
  ): Promise<ForumPostResponse> {
    const authors = await new MemberLookup(this.profiles).byUserIds([
      post.authorId,
    ]);
    const [vote, moderation, thread] = await Promise.all([
      this.votes.findOne({
        where: { postId: post.id, userId: user.userId },
      }),
      this.contentModeration.statesForAnyType(ForumPostsService.SUBJECT_TYPES, [
        post.id,
      ]),
      // Only the accepted-answer pointer is needed here, so this reads the one
      // column rather than hydrating the whole thread row.
      this.posts.manager.findOne(ForumThread, {
        where: { id: post.threadId },
        select: ['id', 'acceptedPostId'],
      }),
    ]);
    return toForumPostResponse(
      post,
      authors.get(post.authorId) ?? null,
      vote?.value ?? 0,
      viewerOf(user),
      moderation.get(post.id) ?? { hidden: false, removed: false },
      thread?.acceptedPostId ?? null,
    );
  }

  // --- internals ---

  private async paginateOldestFirst(
    qb: SelectQueryBuilder<ForumPost>,
    cursor: string | undefined,
    limit: number,
    alias: string,
  ): Promise<{
    rows: ForumPost[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    // `ForumPost.createdAt` is `timestamptz(3)`, matching the millisecond
    // resolution of the JS `Date` cursor `cursorPaginate` builds — so the
    // leading column can compare on the raw `created_at` value with no
    // `date_trunc(...)` wrapper (see `CursorKeyset`'s precision contract and
    // `1787600000000-NarrowForumPostCreatedAtPrecision.ts`). `id` stays the
    // ASC tie-breaker, keeping the ordering total.
    return cursorPaginate(qb, cursor, limit, alias, false, {
      columnExpr: `"${alias}"."created_at"`,
      direction: 'ASC',
      kind: 'date',
      getValue: (row) => row.createdAt,
    });
  }

  // Batched mapping for a page of posts: one `IN`-query each for authors and
  // the viewer's own votes across the whole page instead of N+1 per-post
  // lookups (mirrors `CommunityPostsService.toPostDTOs`).
  private async toPostResponses(
    rows: ForumPost[],
    user: CurrentUserData,
    acceptedPostId: string | null = null,
  ): Promise<ForumPostResponse[]> {
    if (!rows.length) return [];
    const viewer = viewerOf(user);

    // Drop hidden posts (kept for moderators) and pair the survivors with their
    // takedown state before mapping — so the page fills with visible posts and
    // removed ones render as tombstones.
    const survivors = await this.partitionByModeration(rows, viewer);
    if (!survivors.length) return [];

    const postIds = survivors.map(({ post }) => post.id);
    const authorIds = [...new Set(survivors.map(({ post }) => post.authorId))];

    const [authors, myVoteRows] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.votes.find({ where: { postId: In(postIds), userId: user.userId } }),
    ]);

    const myVoteByPost = new Map(
      myVoteRows.map((row) => [row.postId, row.value]),
    );

    return survivors.map(({ post, moderation }) =>
      toForumPostResponse(
        post,
        authors.get(post.authorId) ?? null,
        myVoteByPost.get(post.id) ?? 0,
        viewer,
        moderation,
        acceptedPostId,
      ),
    );
  }
}
