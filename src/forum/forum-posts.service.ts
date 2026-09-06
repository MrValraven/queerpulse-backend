import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { EntityManager, In, Repository, SelectQueryBuilder } from 'typeorm';
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
import {
  DEFAULT_REPLY_SORT,
  ReplySort,
  applyReplyOrder,
  applyTopReplySeek,
  encodeTopRepliesCursor,
  keysetForReplySort,
} from './forum-reply-sort';
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
 * How deep the descendant walk in `loadSubtreeIds` follows `parent_post_id`.
 *
 * Purely a guard against corrupt data: a reply's parent must already exist when
 * the reply is written (`loadReplyParentOr400`), so a chain can never close
 * into a cycle and no honest thread comes close to this. Without the bound, one
 * bad row would make the recursive CTE spin forever and take the request with
 * it.
 */
const MAX_REPLY_DEPTH = 20;

/**
 * Ceiling on the descendant replies one page carries alongside its roots.
 *
 * A page is `limit` TOP-LEVEL replies plus everything nested under them, so its
 * size is set by how deeply the thread's roots are nested rather than by
 * `limit` alone. This is what keeps a single pathological root (one reply with
 * hundreds of nested answers under it) from turning one page into the whole
 * thread. Shallower replies are kept first, so if it ever binds it takes the
 * deepest tail of the conversation, which is also the least-read part of it.
 */
const MAX_SUBTREE_POSTS_PER_PAGE = 300;

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

/**
 * `GET /forum/threads/:slug/posts`' envelope: the ordinary `CursorPage` plus
 * one thread-level fact the page itself cannot carry (C5/ENG-130).
 */
export interface ForumPostsPage extends CursorPage<ForumPostResponse> {
  /**
   * Is the thread's genuine opening post readable by THIS viewer?
   *
   * False in three cases, all of which mean "the OP card has nothing to draw":
   * the viewer has muted its author (a muted member's posts stay silenced even
   * though the thread itself is still reachable), a moderator hid it and the
   * viewer is not staff, or the thread carries no `is_op` post at all.
   *
   * It exists because the thread page used to take the first post of page one
   * as the OP. When the OP was filtered out, the first REPLY moved into the OP
   * card and was read as the question, wearing that replier's name and
   * permissions, while vanishing from the reply list. Carried on every page,
   * not just the first, because it describes the thread rather than the page.
   */
  opAvailable: boolean;
}

const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];

function isModeratorRole(role: string): boolean {
  return MODERATOR_ROLES.includes(role);
}

function viewerOf(user: CurrentUserData): ForumPostViewer {
  return { userId: user.userId, isModerator: isModeratorRole(user.role) };
}

/**
 * Moves a thread's denormalized `replyCount` by `delta` when a reply is
 * tombstoned or restored (ENG-132).
 *
 * THE BUG. `replyCount` was only ever incremented, by `markActivity` on each
 * new reply. Deleting a reply never took it back, so a thread whose three
 * replies had all been withdrawn went on advertising "3 replies" on /forum and
 * in the reply bar, and opening it showed three tombstones.
 *
 * ONLY REPLIES. The opening post is not a reply and was never counted (`create`
 * writes the thread with `replyCount: 0` and its OP in the same transaction),
 * so tombstoning an OP must not decrement — which is also what keeps
 * `deleteThread`, whose whole job is to tombstone the OP, from corrupting the
 * count of a thread it is withdrawing.
 *
 * `GREATEST(..., 0)` rather than a plain `- 1`: the counter is denormalized and
 * has drifted before (this is the drift `BackfillForumThreadReplyCount` repairs),
 * so a decrement that finds it already at zero clamps instead of going negative
 * and rendering "-1 replies" until somebody notices.
 *
 * `lastActivityAt` is deliberately NOT walked back. Recomputing it means an
 * aggregate over the thread's surviving posts on every delete, and it is the
 * `active` sort's keyset column: moving it BACKWARDS while readers hold cursors
 * minted against its old value would drop or repeat whole blocks of threads
 * mid-scroll, which is a worse failure than a withdrawn reply leaving a thread
 * ranked as recently active for a while. The count is the number a reader
 * actually checks, and it is now truthful.
 */
async function adjustReplyCount(
  manager: EntityManager,
  post: ForumPost,
  delta: 1 | -1,
): Promise<void> {
  if (post.isOp) return;
  await manager.update(
    ForumThread,
    { id: post.threadId },
    {
      replyCount: () =>
        delta === 1 ? '"reply_count" + 1' : 'GREATEST("reply_count" - 1, 0)',
    },
  );
}

/**
 * First occurrence of each post id wins. A page is assembled from three sources
 * (the hoisted OP and accepted answer, the root stream, each root's subtree)
 * and a nested accepted answer legitimately appears in two of them; rendering
 * it twice would be worse than either place alone.
 */
function dedupePostsById(posts: ForumPost[]): ForumPost[] {
  const seenIds = new Set<string>();
  const unique: ForumPost[] = [];
  for (const post of posts) {
    if (seenIds.has(post.id)) continue;
    seenIds.add(post.id);
    unique.push(post);
  }
  return unique;
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
      .andWhere('p.deletedAt IS NULL')
      // A reply inside a withdrawn thread is not a side door back into it
      // (PRD-160): this row renders the THREAD's title and links to it, which
      // is exactly what deleting the thread retracted. Same reasoning as the
      // block and Private-community gates below, applied to the new
      // thread-level tombstone.
      .andWhere('t.deletedAt IS NULL');

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

  /**
   * GET /forum/threads/:slug/posts — the opening post plus a page of replies.
   *
   * SHAPE OF A PAGE. Three parts, concatenated:
   *
   *  1. the thread's OP, on the first page only, when this viewer can see it
   *     (see `resolveOpForViewer` and `opAvailable`);
   *  2. the accepted answer, on the first page only, hoisted out of the stream;
   *  3. `limit` TOP-LEVEL replies in the requested sort, plus every reply
   *     nested underneath them.
   *
   * WHY `limit` COUNTS TOP-LEVEL REPLIES, NOT POSTS (C6/PRD-162). Replies are
   * rendered as a TREE (`buildReplyTree`, keyed on `parentPostId`), and a flat
   * page of a tree is only well-formed if every reply arrives at or after its
   * parent. Oldest-first gave that for free, which is why it was the only
   * ordering the endpoint had. `newest` inverts it exactly: a child is always
   * newer than its parent, so a flat newest-first page would deliver children
   * before the parents they belong under and the client would draw them
   * stranded at the root until some later page happened to bring the parent
   * back. Paginating the ROOTS and shipping each root's whole subtree with it
   * keeps every page a complete set of subtrees, in any ordering, which is what
   * makes "Newest" mean "the newest conversations, each still whole" rather
   * than "the newest posts, torn out of their threads".
   *
   * ORDER WITHIN THE ARRAY. Roots come in sort order, then the descendants in
   * the same sort order. The client groups by `parentPostId` and inherits that
   * relative order inside each sibling bucket, so siblings read in the
   * requested order at every depth. The array is a bag of posts to be
   * re-nested, and any consumer that renders it flat will read the roots and
   * then their children, never a strict global ordering.
   *
   * WHY THE ACCEPTED ANSWER IS LIFTED OUT AND RE-INSERTED. It is excluded from
   * the root stream on EVERY page (not just the first) and put back at the top
   * of page one, so it is never rendered twice across a "Load more" session.
   * Excluding it everywhere is what makes that safe: the keyset stays a plain
   * seek, which an `ORDER BY (id = :accepted) DESC, ...` could never be. That
   * property holds identically in all three sorts, which is why the exclusion
   * lives here rather than inside any one of them. This is the server-side
   * ordering that replaced the old client-side "most helpful" heuristic, which
   * only ever ranked the replies that happened to have loaded (SOC-13).
   *
   * THE CURSOR IS SORT-SPECIFIC. `oldest`/`newest` seek on
   * `(created_at, id)` through `cursorPaginate`'s alternate-keyset path;
   * `top` seeks on `(vote_count, created_at, id)` through its own predicate
   * (`applyTopReplySeek`). A cursor minted under one sort decodes to nonsense
   * under another, so the client must drop its cursor when the member changes
   * the sort, exactly as the thread list does.
   */
  async listPosts(
    threadSlug: string,
    user: CurrentUserData,
    cursor: string | undefined,
    limit: number | undefined,
    sort: ReplySort = DEFAULT_REPLY_SORT,
  ): Promise<ForumPostsPage> {
    const thread = await this.threadsService.loadOr404(
      threadSlug,
      user.userId,
      {
        // A withdrawn thread's posts 404 for members and stay readable for staff
        // (PRD-160), matching what `ForumThreadsService.getBySlug` admits — a
        // moderator who can open the thread detail has to be able to read the
        // thread.
        includeDeleted: isModeratorRole(user.role),
      },
    );

    const acceptedPostId = thread.acceptedPostId;
    const { opPost, isOpVisible } = await this.resolveOpForViewer(thread, user);
    const isFirstPage = !cursor;

    const rootsQb = this.posts
      .createQueryBuilder('p')
      .where('p.threadId = :threadId', { threadId: thread.id });
    // The OP is hoisted explicitly below, so it never competes for a slot in
    // the paginated stream.
    rootsQb.andWhere('p.isOp = false');
    // "Top level" is a reply with no parent OR one parented directly to the
    // opening post. The write path allows both (`loadReplyParentOr400` accepts
    // any post in the thread, the OP included) and the client renders them
    // identically, so treating only `parent_post_id IS NULL` as a root would
    // strand every reply-to-the-OP as a descendant of a post that is never a
    // root, i.e. drop it from the endpoint entirely.
    if (opPost) {
      rootsQb.andWhere(
        '(p.parentPostId IS NULL OR p.parentPostId = :rootOpPostId)',
        { rootOpPostId: opPost.id },
      );
    } else {
      rootsQb.andWhere('p.parentPostId IS NULL');
    }
    if (acceptedPostId) {
      rootsQb.andWhere('p.id != :acceptedPostId', { acceptedPostId });
    }
    // Posts by a blocked (either way) or muted author are dropped in-query, so
    // the keyset page below fills to `limit` with visible roots instead of
    // coming back short (see `BlockFilterService.excludeHidden`). NB: this is
    // also what can hide the OP when the thread author is only *muted* — a
    // muted author's thread is still reachable by direct navigation (see
    // `ForumThreadsService.loadOr404`), but their posts stay silenced, which is
    // exactly what a mute means, and `opAvailable` is how the client is told.
    this.blockFilter.excludeHidden(rootsQb, user.userId, '"p"."author_id"');

    const {
      rows: rootRows,
      nextCursor,
      hasMore,
    } = await this.paginateRoots(rootsQb, cursor, limit ?? DEFAULT_LIMIT, sort);

    const descendantRows = await this.loadSubtree(
      thread.id,
      rootRows.map((root) => root.id),
      user,
      sort,
    );

    const hoisted: ForumPost[] = [];
    if (isFirstPage && opPost && isOpVisible) {
      hoisted.push(opPost);
    }
    if (isFirstPage && acceptedPostId) {
      const accepted = await this.loadAcceptedPost(acceptedPostId, user);
      if (accepted) hoisted.push(accepted);
    }

    // Deduped because the accepted answer can be a NESTED reply, in which case
    // it arrives twice: once hoisted, once inside its root's subtree. The
    // hoisted copy wins (it is first), which is what puts it at the top of the
    // page; the client's tree builder re-nests it under its parent when that
    // parent is also on the page, so nothing is lost either way.
    const orderedRows = dedupePostsById([
      ...hoisted,
      ...rootRows,
      ...descendantRows,
    ]);

    return {
      data: await this.toPostResponses(orderedRows, user, acceptedPostId),
      pageInfo: { nextCursor, hasMore },
      opAvailable: isOpVisible,
    };
  }

  /**
   * The thread's opening post and whether THIS viewer can see it (C5/ENG-130).
   *
   * Resolved on every page rather than only the first, because `opAvailable` is
   * a fact about the thread: a client that loaded page three and knows the OP
   * is unavailable can say so without refetching page one. Three small indexed
   * reads, and the block/mute pair short-circuits to nothing when the viewer is
   * the OP's own author (`hiddenUserIds` never reports a member hidden from
   * themselves).
   *
   * The visibility rule is `partitionByModeration`'s, restated for one row: a
   * hidden-but-not-removed post is withheld from ordinary members, while a
   * REMOVED post survives as a tombstone for everyone. A tombstoned OP is
   * therefore still "available" — the OP card renders it as `[deleted]`, which
   * is the honest thing to show and is not the same as having no OP at all.
   */
  private async resolveOpForViewer(
    thread: ForumThread,
    user: CurrentUserData,
  ): Promise<{ opPost: ForumPost | null; isOpVisible: boolean }> {
    const opPost = await this.posts.findOne({
      where: { threadId: thread.id, isOp: true },
    });
    if (!opPost) return { opPost: null, isOpVisible: false };

    const [hiddenAuthorIds, moderationStates] = await Promise.all([
      this.blockFilter.hiddenUserIds(user.userId, [opPost.authorId]),
      this.contentModeration.statesForAnyType(ForumPostsService.SUBJECT_TYPES, [
        opPost.id,
      ]),
    ]);
    const moderation = moderationStates.get(opPost.id);
    const isWithheldByModeration =
      (moderation?.hidden ?? false) &&
      !(moderation?.removed ?? false) &&
      !isModeratorRole(user.role);

    return {
      opPost,
      isOpVisible:
        !hiddenAuthorIds.has(opPost.authorId) && !isWithheldByModeration,
    };
  }

  /**
   * One page of TOP-LEVEL replies in the requested sort.
   *
   * `oldest`/`newest` are one column plus the `id` tie-break in a single
   * direction, so they go through `cursorPaginate`'s alternate-keyset path
   * unchanged. `top` sorts votes descending and then falls back to the oldest
   * reply, which no row-constructor comparison can express, so it carries its
   * own seek and its own cursor codec (`forum-reply-sort.ts` explains both).
   */
  private async paginateRoots(
    qb: SelectQueryBuilder<ForumPost>,
    cursor: string | undefined,
    limit: number,
    sort: ReplySort,
  ): Promise<{
    rows: ForumPost[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const keyset = keysetForReplySort(sort);
    if (keyset) {
      // `false` for the millisecond-precision flag is ignored on the keyset
      // path, which always compares the raw column — safe here because
      // `ForumPost.createdAt` is already `timestamptz(3)`, see `CursorKeyset`.
      return cursorPaginate(qb, cursor, limit, 'p', false, keyset);
    }

    applyTopReplySeek(qb, cursor);
    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];
    return {
      rows: page,
      nextCursor: hasMore && lastRow ? encodeTopRepliesCursor(lastRow) : null,
      hasMore,
    };
  }

  /**
   * Every reply nested underneath this page's roots, at any depth.
   *
   * Two queries. The recursive CTE walks `parent_post_id` down from the roots
   * and returns ids only, bounded by `MAX_REPLY_DEPTH` and
   * `MAX_SUBTREE_POSTS_PER_PAGE`; the second loads those rows through an
   * ordinary query builder so they get the same block/mute filter and the same
   * ORDER BY as the roots. Splitting it that way is what lets
   * `BlockFilterService.excludeHidden` apply at all — it appends to a query
   * builder, and a raw recursive CTE has nothing for it to append to.
   *
   * The walk runs BEFORE the block filter, so a hidden author's reply is
   * dropped while the replies underneath it survive. That is deliberate and
   * matches what the client already does with them: a reply whose parent is not
   * on the page falls back to the root of the tree rather than disappearing
   * with it, so muting one member never silently takes other people's answers
   * with them.
   */
  private async loadSubtree(
    threadId: string,
    rootIds: string[],
    user: CurrentUserData,
    sort: ReplySort,
  ): Promise<ForumPost[]> {
    if (!rootIds.length) return [];

    const rows = await this.posts.manager.query<Array<{ id: string }>>(
      `WITH RECURSIVE "reply_subtree" AS (
         SELECT "seed"."id", 1 AS "depth"
         FROM "forum_post" "seed"
         WHERE "seed"."thread_id" = $1
           AND "seed"."parent_post_id" = ANY($2::uuid[])
         UNION ALL
         SELECT "child"."id", "parent"."depth" + 1
         FROM "forum_post" "child"
         JOIN "reply_subtree" "parent" ON "child"."parent_post_id" = "parent"."id"
         WHERE "child"."thread_id" = $1 AND "parent"."depth" < $3
       )
       SELECT "id" FROM "reply_subtree" ORDER BY "depth" ASC LIMIT $4`,
      [threadId, rootIds, MAX_REPLY_DEPTH, MAX_SUBTREE_POSTS_PER_PAGE],
    );
    const descendantIds = rows.map((row) => row.id);
    if (!descendantIds.length) return [];

    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.id IN (:...descendantIds)', { descendantIds });
    this.blockFilter.excludeHidden(qb, user.userId, '"p"."author_id"');
    applyReplyOrder(qb, sort);
    return qb.getMany();
  }

  /**
   * The thread's accepted answer, loaded for the page-one hoist.
   *
   * Goes through the same block/mute filter as every other row: an accepted
   * answer written by someone the viewer has since blocked or muted stays
   * hidden, exactly as it would in the stream. Null when it is filtered out, or
   * when the mark points at a row that no longer resolves.
   */
  private async loadAcceptedPost(
    acceptedPostId: string,
    user: CurrentUserData,
  ): Promise<ForumPost | null> {
    const qb = this.posts
      .createQueryBuilder('p')
      .where('p.id = :acceptedPostId', { acceptedPostId });
    this.blockFilter.excludeHidden(qb, user.userId, '"p"."author_id"');
    return qb.getOne();
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
  // WHO MAY VOTE (ENG-133). This used to load the post by id and nothing else:
  // no visibility check and no self-vote guard, on the one endpoint that moves
  // a ranking. A blocked member could keep upvoting the person who blocked
  // them, a non-member could vote inside a Private community's thread by
  // holding a post id, and an author could upvote their own opening post to
  // climb the forum's default sort — which `paginateTop` has since made a real
  // ranked ordering rather than a shuffle, so the payoff for doing it went up.
  // `assertCanVote` below closes all three, before the transaction opens.
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
    // Authorized OUTSIDE the transaction on purpose: every check here is a
    // read, none of them touches the row the toggle locks, and holding a write
    // transaction open across four lookups would widen the window in which two
    // concurrent votes contend for nothing.
    await this.assertCanVote(postId, userId);

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

  /**
   * The three gates `POST /forum/posts/:id/vote` never had (ENG-133).
   *
   * 1. THE POST MUST BE VISIBLE TO THE VOTER. Delegated to
   *    `ForumThreadsService.loadByIdOr404`, which is the same helper every
   *    thread read path goes through, so the rule cannot drift from it: a
   *    withdrawn thread, a thread whose author has blocked the voter (or whom
   *    the voter has blocked), and a Private community's thread read by
   *    somebody off the roster all come back 404. Then the POST's own state: a
   *    tombstoned post and a post under a moderator takedown are not content
   *    anybody votes on, including the moderator who can still see it.
   *
   * 2. NO VOTING ACROSS A BLOCK. `loadByIdOr404` covers the THREAD's author;
   *    this covers the post's, which on a reply is somebody else entirely. A
   *    block is a hard severance in both directions, so it is checked in both.
   *    Mute is deliberately NOT a bar: a mute is a soft silence that keeps
   *    content out of lists (`BlockFilterService.isMutedBy`), and a member who
   *    navigates to a muted person's reply and chooses to upvote it is doing
   *    nothing a mute promised to prevent.
   *
   * 3. NO SELF-VOTES. Refused in both directions, so there is nothing to clear
   *    either: `StripForumSelfVotes` deletes the ones already recorded, and
   *    after it no author has a vote of their own left to remove. Voting for
   *    your own post is the cheapest possible way to move the `top` sort, and
   *    it is the one vote that carries no information at all.
   *
   * 404 rather than 403 wherever the post should not be reachable, so a member
   * probing post ids cannot tell an existing private post from a missing one.
   */
  private async assertCanVote(postId: string, userId: string): Promise<void> {
    const post = await this.loadPostOr404(postId);
    if (post.deletedAt) {
      throw new NotFoundException('Post not found');
    }
    await this.threadsService.loadByIdOr404(post.threadId, userId);

    if (post.authorId === userId) {
      throw new ForbiddenException('You cannot upvote your own post');
    }

    const [isBlocked, moderationStates] = await Promise.all([
      this.blockFilter.isBlockedEitherWay(userId, post.authorId),
      this.contentModeration.statesForAnyType(ForumPostsService.SUBJECT_TYPES, [
        post.id,
      ]),
    ]);
    if (isBlocked) {
      throw new NotFoundException('Post not found');
    }
    const moderation = moderationStates.get(post.id);
    if (moderation?.hidden || moderation?.removed) {
      throw new NotFoundException('Post not found');
    }
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
      // One transaction over all three writes. The tombstone, the released
      // answer mark and the reply count describe the same fact; a crash
      // between any two of them leaves the thread advertising something that
      // is no longer true.
      await this.posts.manager.transaction(async (manager) => {
        await manager.save(post);
        // A tombstoned post is no longer an answer. The FK only clears on a HARD
        // delete, so the soft-delete path has to release the mark itself, leaving
        // the thread genuinely unanswered again rather than pointing at an empty
        // tombstone (SOC-13).
        await manager.update(
          ForumThread,
          { id: post.threadId, acceptedPostId: post.id },
          { acceptedPostId: null },
        );
        await adjustReplyCount(manager, post, -1);
      });
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
      // Same transaction argument as `tombstonePost`: the restored reply and
      // the count that advertises it commit together or not at all.
      await this.posts.manager.transaction(async (manager) => {
        await manager.save(post);
        await adjustReplyCount(manager, post, 1);
      });
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
