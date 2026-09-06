import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { InjectRepository } from '@nestjs/typeorm';
import { isUniqueViolation } from '../common/db-errors';
import {
  DataSource,
  EntityManager,
  In,
  IsNull,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';
import { CurrentUserData } from '../auth/decorators/current-user.decorator';
import { FORUM_THREAD_CREATED, ForumThreadCreatedEvent } from './forum.events';
import {
  CursorKeyset,
  CursorPage,
  cursorPaginate,
} from '../common/cursor-pagination';
import { escapeLikeTerm } from '../common/like-escape';
import {
  FORUM_THREAD_SEARCH_COLUMNS,
  FORUM_THREAD_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchQuery,
  foldedSearchTerm,
  searchRankExpression,
  weightedSearchVector,
} from '../search/search-text';
import { MemberLookup } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { ModAuditService } from '../moderation/mod-audit.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { TopicPostLinkService } from '../content/topic-post-link.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import {
  ForumThreadResponse,
  ForumThreadViewer,
  UNREAD_REPLY_COUNT_CAP,
  toForumThreadResponse,
} from './forum-response';
import {
  decodeTopThreadsCursor,
  encodeTopThreadsCursor,
} from './forum-top-keyset';

/**
 * The options every thread visibility gate takes. Shared by `loadOr404` (by
 * slug) and `loadByIdOr404` (by id) so the two entry points cannot drift.
 */
export interface ThreadVisibilityOptions {
  bypassCommunityAccess?: boolean;
  includeDeleted?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_SLUG_ATTEMPTS = 5;
const MAX_TAGS = 5;
// Cap on simultaneously pinned threads — mirrors
// `ConversationsService.MAX_PINNED_CONVERSATIONS`, enforced the same way (an
// application-code count check in `setPinned`, not a DB constraint).
const MAX_PINNED_THREADS = 3;

// How far back `top` looks (PRD-161). `top` with no time window at all means
// "top ever", and on any forum older than a few months that is a fixed monument
// nobody's new thread can join: the same handful of all-time favourites, in the
// same order, every visit. Thirty days makes the tab answer "what is the forum
// rallying around lately", which is the question the reader actually has.
const TOP_WINDOW_DAYS = 30;

// Below this many threads inside the window, `top` drops the window and ranks
// the whole forum instead. A brand-new (or simply quiet) forum would otherwise
// meet its readers with three threads under a tab that promises the best of the
// place. One page's worth is the threshold: fewer than that and the window is
// hiding more than it is focusing.
const TOP_WINDOW_MIN_THREADS = 20;

// How long a thread's author may re-file their own thread (C8/PRD-163).
// Mis-filing is a mistake people notice immediately, and a day is long enough
// to notice it. Past that the thread has been read, replied to and linked from
// its category, so moving it is a janitorial act with consequences for other
// people, and a moderator (who can move it at any time) is the right one to do
// it.
const CATEGORY_MOVE_WINDOW_MS = 24 * 60 * 60 * 1000;

// `content_moderation.subject_type` values a forum post can be filed under —
// the same pair `ForumPostsService.SUBJECT_TYPES` holds (a forum post is
// reportable as either `post` or `reply` depending on the report form it came
// through, both keyed by the post's uuid). Replicated here rather than imported
// because that constant is `private static` on the sibling service, exactly as
// `MODERATOR_ROLES` below is replicated. Keep the two in sync: this one exists
// only so a hidden or removed OP's words stay out of a thread card's `excerpt`.
const OP_MODERATION_SUBJECT_TYPES: readonly string[] = ['post', 'reply'];

// What a thread card assumes about an OP nobody has moderated.
const OP_NOT_MODERATED: ContentModerationState = {
  hidden: false,
  removed: false,
};

// `mod_audit_logs.action` values for the staff thread actions (BE-COM-19).
// Free-form `varchar` on the entity, matching the existing platform actions
// (`suspension_lifted`, `role_changed`, …); the audit feed's `action` filter
// takes the exact string, so these are the contract the admin UI filters on.
const THREAD_AUDIT_ACTIONS = {
  locked: 'thread_locked',
  unlocked: 'thread_unlocked',
  pinned: 'thread_pinned',
  unpinned: 'thread_unpinned',
  officialSet: 'thread_official_set',
  officialCleared: 'thread_official_cleared',
  deleted: 'thread_deleted',
} as const;

// A `GET /forum/threads` sort mode (mirrors `ListThreadsQuery.sort`). `new` and
// `unanswered` page the `(createdAt, id)` keyset; `active` swaps the leading
// keyset column (see `keysetForSort`); `top` has its own three-column keyset
// and recency window (see `paginateTop`).
//
// Omitting `sort` means `active`, NOT `new`: an unparameterised call is a
// reader arriving at the forum with no opinion, and "where is the conversation
// right now" serves them better than either "what was posted most recently"
// (which buries a thread the moment anything newer exists, however dead) or the
// old frontend default of `top` (see `paginateTop`). The frontend default
// matches.
export type ThreadSort = 'new' | 'top' | 'active' | 'unanswered';

// Per-category visible-thread counts plus an `all` total — the
// `GET /forum/threads/counts` shape (`{ all } & Record<category, number>`).
export type ThreadCategoryCounts = Record<string, number>;

// The moderator predicate `ForumPostsService` uses (a `CurrentUserData.role`,
// derived from the JWT, of `moderator` or `admin`). Replicated here rather than
// imported — it isn't exported from that sibling service — so lock/unlock gate
// on exactly the same roles. Keep the two in sync.
const MODERATOR_ROLES: readonly string[] = [UserRole.Moderator, UserRole.Admin];
// Exported so `ForumController` threads the exact same moderator predicate into
// the read paths (`list`/`getBySlug`/`create`) that need the viewer's role to
// compute the OP card's moderation/lock flags — one source of truth.
export function isModeratorRole(role: string): boolean {
  return MODERATOR_ROLES.includes(role);
}

// Normalizes author-supplied tags for storage: trim, lowercase, strip a leading
// `#`, drop empties, dedupe (first-wins), cap at `MAX_TAGS`. Applied on create +
// update so `forum_thread.tags` is always clean and matches the same shape the
// `:tag = ANY(t.tags)` filter normalizes a query tag to (`normalizeTag`).
function normalizeTags(tags: string[] | undefined): string[] {
  if (!tags) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tags) {
    const tag = raw.trim().toLowerCase().replace(/^#+/, '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

// Normalizes a single filter tag to the same shape `normalizeTags` stores, so
// `?tag=%23Housing` matches a persisted `housing`.
function normalizeTag(tag: string): string {
  return tag.trim().toLowerCase().replace(/^#+/, '').trim();
}

export interface CreateThreadInput {
  title: string;
  body: string;
  category: string;
  tags?: string[];
  communitySlug?: string;
  isOfficial?: boolean;
  /** Storage key of one optional photo on the opening post (SOC-13). */
  image?: string;
}

@Injectable()
export class ForumThreadsService {
  private readonly logger = new Logger(ForumThreadsService.name);

  constructor(
    @InjectRepository(ForumThread)
    private readonly threads: Repository<ForumThread>,
    @InjectRepository(ForumPost)
    private readonly posts: Repository<ForumPost>,
    @InjectRepository(ForumPostVote)
    private readonly votes: Repository<ForumPostVote>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(ForumPostEdit)
    private readonly edits: Repository<ForumPostEdit>,
    private readonly dataSource: DataSource,
    private readonly blockFilter: BlockFilterService,
    private readonly mentions: MentionNotificationService,
    private readonly eventEmitter: EventEmitter2,
    private readonly membership: CommunityMembershipService,
    // DISC-5 — reconciles a newly created thread's tags against the topics
    // directory (`ContentModule`, imported by `ForumModule`).
    private readonly topicPostLink: TopicPostLinkService,
    // BE-COM-19 — lock/pin/official are staff actions that mutate a thread
    // every member can see; they append a `mod_audit_logs` row so `GET
    // /mod/audit` and its CSV export (the governance audit trail) are not
    // silently missing them. Exported by `ModerationModule`, imported by
    // `ForumModule`.
    private readonly modAudit: ModAuditService,
    // SOC-13 — thread following. Owned by this module, so a plain constructor
    // injection: it exists to be shared between `ForumThreadsService` (auto
    // -subscribe the author on create, resolve `isSubscribed` on every read)
    // and `ForumPostsService` (auto-subscribe the replier, fan the reply out).
    private readonly subscriptions: ForumSubscriptionsService,
    // PRD-167 — the thread card now carries an `excerpt` of the opening post,
    // so the read paths have to know whether a moderator hid or removed that
    // OP before they quote it. One batched lookup per page (see
    // `resolveOpModeration`). Exported by `ContentModerationModule`, already
    // imported by `ForumModule` for `ForumPostsService`'s own read policy.
    private readonly contentModeration: ContentModerationService,
  ) {}

  // GET /forum/threads?category=&cursor=&sort=&tag=&q= — a cursor page ordered
  // by `sort` (default `active`), narrowed by category/tag/text.
  async list(
    viewerId: string,
    category: string | undefined,
    cursor: string | undefined,
    limit: number | undefined,
    sort?: ThreadSort,
    tag?: string,
    q?: string,
    viewerIsModerator = false,
  ): Promise<CursorPage<ForumThreadResponse>> {
    const qb = this.threads.createQueryBuilder('t');
    // Threads by a member blocked either way, or one the viewer has muted,
    // never enter the page (spec §2). Applied to the query rather than to the
    // fetched rows so `cursorPaginate`'s `LIMIT` counts only visible threads —
    // post-query filtering (`FeedService.dropBlocked`) returns short pages.
    // `t`'s author column is `author_id` under `SnakeNamingStrategy`.
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    // A Private community's threads never enter a non-member's browse list
    // (H1) — same gate `loadOr404`/the feed apply, so the list can't leak a
    // thread the detail read would 404.
    this.applyCommunityAccessFilter(qb, viewerId);
    // A withdrawn thread leaves the browse list for everyone but staff
    // (PRD-160), before any of the narrowing below, so the same set every other
    // read path admits is the set the page is drawn from.
    this.excludeDeletedThreads(qb, viewerIsModerator);
    if (category) {
      qb.andWhere('t.category = :category', { category });
    }
    // Pinned threads live in their own bucket (`listPinned`, rendered above
    // this paginated list) — excluded here so a pinned thread never appears
    // twice across a scroll session.
    qb.andWhere('t.is_pinned = false');
    // `q`/`tag` fold in AFTER the block filter (spec §Backend): same visibility
    // rules first, then narrow the visible set by text (title or any visible
    // reply body, C9) / tag membership.
    this.applyTextAndTagFilters(qb, q, tag);
    // `unanswered` is not a distinct sort column — it's the default
    // `(createdAt, id)` keyset narrowed to UNRESOLVED threads, so it keeps
    // `keysetForSort` returning undefined below.
    //
    // It used to narrow on `reply_count = 0`, which made the label a lie: a
    // question with forty replies and no resolution counted as answered, and
    // the one sort that could have surfaced the forum's open questions instead
    // surfaced only the ones nobody had spoken in yet. It now means what it
    // says — no accepted answer — backed by the partial keyset index
    // `IDX_forum_thread_unanswered_created_at_id`, which covers exactly the
    // rows this branch can return (SOC-13).
    if (sort === 'unanswered') {
      qb.andWhere('t.accepted_post_id IS NULL');
    }

    // `top` needs three sort columns and a recency window, neither of which the
    // shared `CursorKeyset` models, so it pages through its own seek (see
    // `paginateTop`). Every other sort goes through `cursorPaginate`.
    const page =
      sort === 'top'
        ? await this.paginateTop(qb, cursor, limit ?? DEFAULT_LIMIT)
        : // `keyset` swaps the leading sort column for `active` (and for an
          // omitted sort, which means `active`); for `new`/`unanswered` it's
          // undefined, so `cursorPaginate` uses its default `(createdAt, id)`
          // keyset with the `true` millisecond-precision flag.
          // `ForumThread.createdAt` is migrated to `timestamptz(3)` (see
          // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so that default
          // path uses `IDX_forum_thread_created_at_id` instead of a full scan +
          // in-memory sort; the `active` keyset is backed by its own DESC
          // composite index (`AddForumOpDenormalization`, narrowed to the
          // undeleted rows by `AddForumThreadSoftDelete`).
          await cursorPaginate(
            qb,
            cursor,
            limit ?? DEFAULT_LIMIT,
            't',
            true,
            this.keysetForSort(sort),
          );

    return {
      data: await this.toThreadResponses(
        page.rows,
        viewerId,
        viewerIsModerator,
      ),
      pageInfo: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
  }

  /**
   * The `top` sort's own keyset page (PRD-161).
   *
   * TWO THINGS ARE WRONG WITH A NAIVE `top`, and this fixes both.
   *
   * First, the ORDER. `op_vote_count DESC, id DESC` has no meaningful second
   * sort key, so every thread on zero votes comes back in uuid order. On a
   * young forum that is nearly every thread, which made the forum's landing
   * page a shuffled list that did not change as people posted, and buried a
   * thread from a minute ago under anything that had ever collected one upvote.
   * `last_activity_at` goes in the middle, so the zero-vote tail (and every
   * other tie) falls back to recency.
   *
   * Second, the WINDOW. With no time bound at all, `top` means "top ever" and
   * the tab becomes a monument: the same all-time favourites, in the same
   * order, that no new thread can ever join. Narrowing to threads created in
   * the last `TOP_WINDOW_DAYS` makes it mean "top recently", which is the
   * question a reader opening that tab is asking.
   *
   * The window is dropped entirely when fewer than `TOP_WINDOW_MIN_THREADS`
   * threads fall inside it, because a quiet month must not meet readers with a
   * near-empty page under a tab promising the best of the forum. That decision
   * is made once, on the first page, and then RIDES IN THE CURSOR
   * (`encodeTopThreadsCursor`) so every later page of the same scroll answers
   * the same question. Re-deciding per page would let a thread created
   * underneath the reader flip the window mid-scroll and drop or repeat whole
   * blocks of threads.
   *
   * Like the other mutable-key sorts, a vote or a reply can still move a thread
   * across a page boundary mid-scroll; see `keysetForSort` for why that is
   * accepted here.
   */
  private async paginateTop(
    qb: SelectQueryBuilder<ForumThread>,
    cursor: string | undefined,
    limit: number,
  ): Promise<{
    rows: ForumThread[];
    nextCursor: string | null;
    hasMore: boolean;
  }> {
    const decoded = cursor ? decodeTopThreadsCursor(cursor) : null;
    const windowStart = new Date(
      Date.now() - TOP_WINDOW_DAYS * 24 * 60 * 60 * 1000,
    );
    // First page decides; later pages inherit. The count runs against a CLONE
    // carrying every filter already folded onto `qb` (blocks, community access,
    // deleted, category, q/tag), so it counts exactly the threads this page
    // could return, never the whole table.
    const isWindowed = decoded
      ? decoded.isWindowed
      : (await qb
          .clone()
          .andWhere('t.created_at >= :topWindowStart', {
            topWindowStart: windowStart,
          })
          .getCount()) >= TOP_WINDOW_MIN_THREADS;
    if (isWindowed) {
      qb.andWhere('t.created_at >= :topWindowStart', {
        topWindowStart: windowStart,
      });
    }

    // Raw column expressions, matching `cursorPaginate`'s alternate-keyset
    // path: TypeORM re-parses a dotted ORDER BY term as `alias.column`, so the
    // quoted form is what keeps these verbatim. All three descend, which is
    // what lets `IDX_forum_thread_top_keyset` serve the whole ordering.
    qb.orderBy('"t"."op_vote_count"', 'DESC')
      .addOrderBy('"t"."last_activity_at"', 'DESC')
      .addOrderBy('t.id', 'DESC');

    if (decoded) {
      // Row-constructor comparison, so the three columns are compared as one
      // tuple and a page boundary can never fall between two threads the cursor
      // cannot separate. `<` because every column descends.
      qb.andWhere(
        `("t"."op_vote_count", "t"."last_activity_at", "t"."id") < (:topVoteCount, :topLastActivityAt, :topId)`,
        {
          topVoteCount: decoded.opVoteCount,
          topLastActivityAt: decoded.lastActivityAt,
          topId: decoded.id,
        },
      );
    }

    // `limit + 1` to detect a further page without a second count query, the
    // extra row trimmed before returning — same shape as `cursorPaginate`.
    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      rows: page,
      nextCursor:
        hasMore && lastRow ? encodeTopThreadsCursor(lastRow, isWindowed) : null,
      hasMore,
    };
  }

  // GET /forum/threads/counts?q=&tag= — per-category visible-thread counts plus
  // an `all` total, honoring the same block filter + q/tag narrowing as
  // `list()`. One `GROUP BY category` query, never a per-category round-trip.
  async counts(
    viewerId: string,
    q: string | undefined,
    tag: string | undefined,
    viewerIsModerator = false,
  ): Promise<ThreadCategoryCounts> {
    const qb = this.threads
      .createQueryBuilder('t')
      .select('t.category', 'category')
      .addSelect('COUNT(*)', 'count')
      .groupBy('t.category');
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    // Same Private-community gate as `list` (H1) so the category badges never
    // count threads the viewer can't open.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Same soft-delete gate as `list` (PRD-160): a badge that counts a
    // withdrawn thread promises a row the list will not draw, and the count is
    // itself a leak — "this category has one more thread than you can see".
    this.excludeDeletedThreads(qb, viewerIsModerator);
    this.applyTextAndTagFilters(qb, q, tag);

    const rows = await qb.getRawMany<{ category: string; count: string }>();
    // Accumulate per-category counts and the running `all` total in one pass.
    // `COUNT(*)` comes back as a string (pg bigint). `{ all }` is spread last so
    // an empty result still returns `{ all: 0 }`.
    const perCategory: Record<string, number> = {};
    let all = 0;
    for (const row of rows) {
      const count = Number(row.count);
      perCategory[row.category] = count;
      all += count;
    }
    return { ...perCategory, all };
  }

  /**
   * Appends one `mod_audit_logs` row for a staff thread action (BE-COM-19).
   *
   * These actions carry no report and no target member, so the audit feed's
   * `subjectFor()` would render them as the generic "Platform action". The
   * thread's title and slug therefore go into `note`, which is both the
   * column the feed shows as the reason and the one its `q` free-text filter
   * searches — so a moderator can find "who locked this thread" by pasting
   * the slug.
   *
   * Best-effort: the thread mutation this documents has already committed, so
   * a failed audit write is logged and swallowed rather than turned into a
   * 500 for an action that actually succeeded (same posture as
   * `RoadmapAdminService.audit`). It is deliberately the caller's
   * responsibility to only call this on a real state transition.
   */
  private async auditThreadAction(
    user: CurrentUserData,
    action: string,
    thread: ForumThread,
    reason?: string,
  ): Promise<void> {
    const note = reason
      ? `Thread "${thread.title}" (${thread.slug}) — ${reason}`
      : `Thread "${thread.title}" (${thread.slug})`;
    try {
      await this.modAudit.writeAuditLog(
        null,
        user.userId,
        action,
        undefined,
        note,
      );
    } catch (error) {
      this.logger.warn(
        `Failed to write the ${action} audit row for forum thread ${thread.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  // POST /forum/threads/:slug/lock|unlock — moderator-only lock toggle. The
  // role gate isn't resource-scoped, so a non-moderator gets 403 up front,
  // before the slug is even resolved. Idempotent: re-locking a locked thread is
  // a no-op write-wise but still echoes the current state. `reason` is only
  // ever applied on the locking transition (`unlock` never passes one) and is
  // cleared back to null on unlock — see `ForumThread.lockReason`'s docstring.
  async setLocked(
    slug: string,
    user: CurrentUserData,
    locked: boolean,
    reason?: string,
  ): Promise<ForumThreadResponse> {
    if (!isModeratorRole(user.role)) {
      throw new ForbiddenException('Only a moderator can lock threads');
    }
    // The role gate above proved a platform moderator — let them act on a
    // thread in any community, including a Private one they aren't a member of
    // (the community access gate is for non-member READS, not moderation).
    const thread = await this.loadOr404(slug, user.userId, {
      bypassCommunityAccess: true,
      // A withdrawn thread stays reachable to staff, so a lock applied as part
      // of handling a report does not depend on the author not having deleted
      // it first (PRD-160).
      includeDeleted: true,
    });
    if (thread.isLocked !== locked) {
      thread.isLocked = locked;
      const trimmedReason = reason?.trim();
      thread.lockReason = locked && trimmedReason ? trimmedReason : null;
      await this.threads.save(thread);
      // Only on an actual transition: re-locking an already-locked thread is
      // a no-op write, and a no-op does not belong in an audit trail.
      await this.auditThreadAction(
        user,
        locked ? THREAD_AUDIT_ACTIONS.locked : THREAD_AUDIT_ACTIONS.unlocked,
        thread,
        locked && trimmedReason ? trimmedReason : undefined,
      );
    }
    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
    ]);
    // The role gate above already proved the caller is a moderator.
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
    );
  }

  // POST /forum/threads/:slug/pin|unpin — moderator-only pin toggle, same
  // shape as `setLocked`. Pinning past `MAX_PINNED_THREADS` 409s rather than
  // silently displacing an older pin — the caller unpins one first.
  // `pinnedAt` is the ordering watermark (`listPinned` sorts by it): set to
  // `now()` on pin, cleared to `null` on unpin so a re-pin gets a fresh
  // timestamp rather than reusing a stale one.
  async setPinned(
    slug: string,
    user: CurrentUserData,
    pinned: boolean,
  ): Promise<ForumThreadResponse> {
    if (!isModeratorRole(user.role)) {
      throw new ForbiddenException('Only a moderator can pin threads');
    }
    // See `setLocked`: a platform moderator may pin a thread regardless of the
    // community's access tier.
    const thread = await this.loadOr404(slug, user.userId, {
      bypassCommunityAccess: true,
      // See `setLocked`: staff reach a withdrawn thread (PRD-160). Unpinning
      // one is the realistic case here.
      includeDeleted: true,
    });
    if (thread.isPinned !== pinned) {
      if (pinned) {
        // Withdrawn threads do not hold a pin slot: they are not in anybody's
        // sticky bucket, so counting one would silently cost the forum a pin
        // nobody can see or release (PRD-160).
        const pinnedCount = await this.threads.count({
          where: { isPinned: true, deletedAt: IsNull() },
        });
        if (pinnedCount >= MAX_PINNED_THREADS) {
          throw new ConflictException(
            `Only ${MAX_PINNED_THREADS} threads can be pinned at once`,
          );
        }
      }
      thread.isPinned = pinned;
      thread.pinnedAt = pinned ? new Date() : null;
      await this.threads.save(thread);
      await this.auditThreadAction(
        user,
        pinned ? THREAD_AUDIT_ACTIONS.pinned : THREAD_AUDIT_ACTIONS.unpinned,
        thread,
      );
    }
    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
    ]);
    // The role gate above already proved the caller is a moderator.
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
    );
  }

  // PATCH /admin/forum/threads/:slug/official — admin-only toggle, flipping a
  // published thread's displayed author between the real poster and
  // "QueerPulse Official" (see `isOfficial` on the entity). Reachable only
  // through `AdminForumController`, which gates the whole controller on the
  // admin role via `RolesGuard`/`@Roles(UserRole.Admin)` — unlike
  // `setLocked`/`setPinned`, there's no in-method role check here.
  async setOfficial(
    slug: string,
    user: CurrentUserData,
    official: boolean,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, undefined, {
      // Admin-only route; a withdrawn thread stays reachable (PRD-160).
      includeDeleted: true,
    });
    if (thread.isOfficial !== official) {
      thread.isOfficial = official;
      await this.threads.save(thread);
      await this.auditThreadAction(
        user,
        official
          ? THREAD_AUDIT_ACTIONS.officialSet
          : THREAD_AUDIT_ACTIONS.officialCleared,
        thread,
      );
    }
    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
    );
  }

  // GET /forum/threads/pinned?category= — the small, unpaginated "sticky"
  // bucket rendered above the regular list (see `list()`, which excludes
  // pinned threads from its own page so nothing appears twice). Most-recently-
  // pinned first; capped at `MAX_PINNED_THREADS` (already enforced on write by
  // `setPinned`, so this cap is a defensive ceiling, not expected to bite).
  async listPinned(
    viewerId: string,
    category: string | undefined,
    viewerIsModerator: boolean,
  ): Promise<ForumThreadResponse[]> {
    const qb = this.threads
      .createQueryBuilder('t')
      .andWhere('t.is_pinned = true');
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    // Same Private-community gate as `list` (H1): a pinned thread in a Private
    // community stays out of a non-member's sticky bucket.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Same soft-delete gate as `list` (PRD-160). A pinned thread that is later
    // withdrawn would otherwise be the loudest row on the page.
    this.excludeDeletedThreads(qb, viewerIsModerator);
    if (category) {
      qb.andWhere('t.category = :category', { category });
    }
    const rows = await qb
      .orderBy('t.pinned_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(MAX_PINNED_THREADS)
      .getMany();
    return this.toThreadResponses(rows, viewerId, viewerIsModerator);
  }

  // Cross-entity global search (SearchService). Ranked and accent-insensitive
  // since SOC-08: a full-text branch over the accent-folded title supplies
  // relevance, and the old substring branch is kept OR'd alongside it so
  // "trans" still finds "transfeminine" (full text matches whole tokens, so
  // replacing the substring test outright would have been a regression).
  // Reply bodies live in `ForumPostsService.searchByText`, a separate result
  // type. Reuses the same block filter and Private-community gate as `list()`.
  async searchByText(
    viewerId: string,
    term: string,
    limit: number,
    offset = 0,
  ): Promise<ForumThreadResponse[]> {
    const pattern = `%${escapeLikeTerm(term)}%`;
    const searchVector = weightedSearchVector('t', FORUM_THREAD_SEARCH_FIELDS);
    const searchHaystack = foldedHaystack('t', FORUM_THREAD_SEARCH_COLUMNS);
    const searchTsQuery = foldedSearchQuery('searchTerm');
    const foldedTerm = foldedSearchTerm('searchTerm');
    const foldedPattern = foldedSearchTerm('searchPattern');
    const qb = this.threads
      .createQueryBuilder('t')
      .where(
        `(${searchVector} @@ ${searchTsQuery} OR ${searchHaystack} LIKE ${foldedPattern})`,
        { searchTerm: term, searchPattern: pattern },
      );
    this.blockFilter.excludeHidden(qb, viewerId, '"t"."author_id"');
    // Same Private-community gate as `list` (H1): global search must not
    // surface a Private community's thread titles to a non-member.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Withdrawn threads leave global search too (PRD-160), unconditionally: the
    // caller (`SearchService`) carries only the viewer's id and this path
    // already treats every viewer as a non-moderator (see the `false` passed to
    // `toThreadResponses` below), so there is no staff view to preserve here.
    this.excludeDeletedThreads(qb, false);
    // Relevance first, recency as the tiebreaker. Selected under a DOT-FREE
    // alias and ordered by that alias for the same reason
    // `ProfilesService.searchMembers` does it: TypeORM re-parses every ORDER BY
    // term as `alias.column`, and a raw expression full of dots would be
    // mistaken for one.
    const rows = await qb
      .addSelect(
        searchRankExpression(
          searchVector,
          searchTsQuery,
          searchHaystack,
          foldedTerm,
        ),
        'search_rank',
      )
      .orderBy('search_rank', 'DESC')
      .addOrderBy('t.last_activity_at', 'DESC')
      // `.limit()`/`.offset()` rather than `.take()`/`.skip()`: this query
      // orders by a selected expression alias, and `.take()`'s DISTINCT-id
      // rewrite cannot carry one.
      .limit(limit)
      .offset(offset)
      .getMany();
    // Search cards don't surface OP moderation actions; the caller
    // (`SearchService`) has only the viewer id, so treat as non-moderator.
    return this.toThreadResponses(rows, viewerId, false);
  }

  // GET /forum/threads/:slug
  async getBySlug(
    slug: string,
    viewerId: string,
    viewerIsModerator = false,
  ): Promise<ForumThreadResponse> {
    // A non-member reading a Private community's thread by slug 404s (H1); a
    // platform moderator bypasses so they can still open a reported thread.
    const thread = await this.loadOr404(slug, viewerId, {
      bypassCommunityAccess: viewerIsModerator,
      // Direct navigation to a withdrawn thread 404s for everybody but staff
      // (PRD-160), who keep the detail view so a report against it stays
      // reviewable.
      includeDeleted: viewerIsModerator,
    });
    const [authors, op, isSubscribed, unreadByThread] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, viewerId),
      this.subscriptions.isSubscribed(thread.id, viewerId),
      // Read BEFORE the member's own `POST /threads/:slug/read` lands, which is
      // the point: this is the count of what arrived while they were away, and
      // the thread page uses it to mark where they left off.
      this.unreadReplyCountsByThread([thread.id], viewerId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: viewerId, isModerator: viewerIsModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
      unreadByThread.get(thread.id) ?? null,
    );
  }

  /**
   * POST /forum/threads/:slug/read — stamp the viewer's read watermark
   * (C7/PRD-170).
   *
   * The forum had no unread marker of any kind. A member following five threads
   * got notifications, but the list gave them nothing: no watermark, no
   * per-thread badge, no highlight of what had arrived since. Catching up meant
   * reopening each thread and scrolling for something they might well have read
   * already.
   *
   * READING IS NOT FOLLOWING. `markRead` creates the row with
   * `is_following = false` and never touches that flag again, so opening a
   * thread stamps where the member got to and signs them up for nothing. The
   * two facts live on one row precisely so they can be written independently
   * (see `ForumThreadSubscription`).
   *
   * Goes through `loadOr404` with the caller's id, so a watermark can only be
   * stamped on a thread the member could actually read: a Private community's
   * thread, a blocked author's thread and a withdrawn thread all 404 here
   * exactly as they do everywhere else.
   *
   * Returns `{ ok: true }` rather than the thread. It fires on every thread
   * open, the client already holds the thread it just rendered, and the only
   * field the stamp changes is the one the client is about to clear anyway.
   */
  async markRead(slug: string, user: CurrentUserData): Promise<{ ok: true }> {
    const thread = await this.loadOr404(slug, user.userId);
    await this.subscriptions.markRead(thread.id, user.userId);
    return { ok: true };
  }

  // POST /forum/threads — creates the thread row *and* its OP post (the
  // oldest `ForumPost` for the thread) atomically, with a unique slug
  // allocated from `title` (mirrors `EventsService.saveWithUniqueSlug` /
  // `CommunitiesService.createWithUniqueRef`'s retry-on-23505 loop).
  async create(
    authorId: string,
    input: CreateThreadInput,
    viewerIsModerator = false,
    viewerIsAdmin = false,
  ): Promise<ForumThreadResponse> {
    // Resolve the optional community BEFORE the create transaction opens —
    // a non-member gets 403 (or a missing/archived community 404s) without a
    // thread ever being inserted. Mirrors `EventsService.create`.
    let communityId: string | null = null;
    if (input.communitySlug) {
      communityId = await this.membership.assertMemberBySlug(
        input.communitySlug,
        authorId,
      );
    }
    // Only an admin can actually post as "QueerPulse Official" — silently
    // coerced here (not a 403) since the composer only shows the checkbox to
    // admins in the first place; anyone else's value is simply ignored.
    const isOfficial = viewerIsAdmin && !!input.isOfficial;
    const { thread, opPost } = await this.createWithUniqueSlug(
      authorId,
      { ...input, isOfficial },
      communityId,
    );
    // After the thread has committed: record it as public profile activity for
    // the author. Fire-and-forget on the event bus — a listener failure must
    // never affect thread creation (see profiles `ActivityListener`).
    this.eventEmitter.emit(FORUM_THREAD_CREATED, {
      authorId,
      threadSlug: thread.slug,
      title: thread.title,
    } satisfies ForumThreadCreatedEvent);
    // SOC-13 — the author follows their own thread from the moment it exists,
    // so the replies to a question they asked reach them without a second
    // deliberate act. Best-effort: the thread has already committed.
    await this.subscriptions.subscribeQuietly(thread.id, authorId);
    // DISC-5 — best-effort, never throws (see `TopicPostLinkService.linkThread`);
    // a matching tag materializes a `topic_post` row and fans out DISC-3's
    // topic-follow notification (`TOPIC_POST_LINKED`, topics module).
    await this.topicPostLink.linkThread(thread, input.body);
    await this.mentions.notify(input.body, authorId, {
      actorId: authorId,
      source: 'forum',
      threadSlug: thread.slug,
      excerpt: input.body.slice(0, 140),
    });
    const authors = await new MemberLookup(this.profiles).byUserIds([authorId]);
    // The author has just created the OP and cannot have voted on it yet, so
    // `myVote` is 0 by construction — no vote lookup needed for this echo. The
    // fresh OP is live (not tombstoned/edited), so its card flags follow from
    // authorship + the viewer's own moderator role.
    return toForumThreadResponse(
      thread,
      authors.get(authorId) ?? null,
      { userId: authorId, isModerator: viewerIsModerator },
      opPost,
      0,
      // The author was just auto-subscribed above, so the echo can say so
      // without a read-back.
      true,
    );
  }

  /**
   * Shared with `ForumPostsService` — 404s a thread lookup by slug.
   *
   * When `viewerId` is supplied, a thread whose author is blocked in either
   * direction is also 404 — the same "don't leak existence" shape
   * `CommunityPostsService.assertViewable` uses for private communities, so a
   * blocked author's thread can't be reached by guessing its slug either.
   *
   * Also gates community access: a thread scoped to a Private community 404s
   * for a viewer who isn't on that community's roster (again mirroring
   * `CommunityPostsService.assertViewable`), so a private community's threads
   * and their posts can't be read by a non-member who guesses or holds the
   * slug. Because `ForumPostsService.reply`/read paths load through here with
   * the viewer's id, this closes the thread-detail AND post-list leak in one
   * place. Threads with a null `communityId` (flat/global) and threads in
   * non-Private communities stay reachable by everyone. Privileged callers
   * (moderator lock/pin) pass `bypassCommunityAccess` so they can still act on
   * a thread in a community they don't happen to be a member of.
   *
   * Deliberately checks blocks only, not mutes: a mute is a soft silence that
   * keeps content out of feeds and lists (see `BlockFilterService.isMutedBy`),
   * not a hard severance — a muted member's thread stays reachable if the
   * viewer navigates to it directly.
   *
   * Also 404s a thread its author withdrew or a moderator took down
   * (PRD-160), so a link someone already holds stops working the moment the
   * thread is deleted, and the browse list and the direct read agree about what
   * exists. `includeDeleted` is for the callers that must still reach one: the
   * staff detail read, the staff moderation actions, and `deleteThread` itself
   * (which needs a repeated delete to be idempotent rather than a 404).
   */
  async loadOr404(
    slug: string,
    viewerId?: string,
    options?: ThreadVisibilityOptions,
  ): Promise<ForumThread> {
    const thread = await this.threads.findOne({ where: { slug } });
    if (!thread) {
      throw new NotFoundException('Thread not found');
    }
    await this.assertVisibleOr404(thread, viewerId, options);
    return thread;
  }

  /**
   * `loadOr404` addressed by id instead of slug, under exactly the same
   * visibility contract (read that docstring; every rule there applies here).
   *
   * Exists for the callers that hold a post rather than a slug —
   * `ForumPostsService.assertCanVote` is the first (ENG-133). Voting had no
   * visibility check at all, and re-deriving one at the vote endpoint would
   * have meant a second, quietly diverging copy of the deleted-thread, block
   * and Private-community rules. Both entry points share
   * `assertVisibleOr404`, so there is one set of rules and one place to change
   * them.
   */
  async loadByIdOr404(
    threadId: string,
    viewerId?: string,
    options?: ThreadVisibilityOptions,
  ): Promise<ForumThread> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) {
      throw new NotFoundException('Thread not found');
    }
    await this.assertVisibleOr404(thread, viewerId, options);
    return thread;
  }

  /** The visibility gates `loadOr404` documents, shared with `loadByIdOr404`. */
  private async assertVisibleOr404(
    thread: ForumThread,
    viewerId?: string,
    options?: ThreadVisibilityOptions,
  ): Promise<void> {
    if (thread.deletedAt && !options?.includeDeleted) {
      throw new NotFoundException('Thread not found');
    }
    if (
      viewerId &&
      (await this.blockFilter.isBlockedEitherWay(viewerId, thread.authorId))
    ) {
      throw new NotFoundException('Thread not found');
    }
    if (
      viewerId &&
      !options?.bypassCommunityAccess &&
      thread.communityId &&
      (await this.isCommunityHiddenFrom(thread.communityId, viewerId))
    ) {
      throw new NotFoundException('Thread not found');
    }
  }

  /**
   * Shared with `ForumPostsService.reply` — a thread scoped to a community
   * takes replies from that community's ROSTER only.
   *
   * `create` has always required membership (`assertMemberBySlug`), and
   * `loadOr404`'s access gate keeps a Private community's threads out of a
   * non-member's reach entirely. This closes the remaining half (BE-COM-05):
   * on a `request`/`invite` tier the thread is readable platform-wide, but
   * writing into it is a roster action, exactly as it is for the community's
   * own post feed (`CommunityPostsService.assertMember` on every write while
   * `listPosts` stays open to non-members).
   *
   * A flat/global thread (`communityId: null`) has no roster, so this is a
   * no-op for the forum's ordinary threads.
   */
  async assertCanReplyInThread(
    thread: ForumThread,
    userId: string,
  ): Promise<void> {
    if (!thread.communityId) return;
    if (!(await this.membership.isMember(thread.communityId, userId))) {
      throw new ForbiddenException(
        'Only members of this community can reply in its threads',
      );
    }
  }

  /**
   * Called by `ForumPostsService.reply` on every new reply: bumps
   * `replyCount` (atomic increment) and refreshes `lastActivityAt` to now —
   * the two fields the frontend's "recently active" thread sort and reply
   * badge depend on.
   */
  async markActivity(
    threadId: string,
    existingManager?: EntityManager,
  ): Promise<void> {
    // Atomic SQL increment (never a read-modify-write, which would lose bumps
    // under concurrent replies) plus a `lastActivityAt` refresh — the two
    // fields the "recently active" sort/badge depend on.
    const run = async (manager: EntityManager): Promise<void> => {
      await manager.increment(ForumThread, { id: threadId }, 'replyCount', 1);
      await manager.update(
        ForumThread,
        { id: threadId },
        { lastActivityAt: new Date() },
      );
    };
    // Run inside the caller's transaction when given one — `reply()` passes
    // its manager so the reply insert and this count bump commit together (a
    // crash between them would otherwise drift `replyCount`). Standalone
    // callers get their own one-shot transaction.
    if (existingManager) {
      await run(existingManager);
      return;
    }
    await this.dataSource.transaction(run);
  }

  /**
   * PATCH /forum/threads/:slug — the thread's title, its tag set and/or its
   * category.
   *
   * THREE DIFFERENT PERMISSIONS, deliberately.
   *
   * The TITLE stays author-only: a moderator rewriting the words someone chose
   * is an editorial act the forum has no appeal path for.
   *
   * TAGS are author-or-moderator at any time: filing a thread under the right
   * topic is janitorial, it is what makes the archive findable, and until
   * SOC-13 the frontend never sent a tag edit at all even though the backend
   * already accepted one.
   *
   * The CATEGORY (C8/PRD-163) is author-within-`CATEGORY_MOVE_WINDOW_MS`, or
   * moderator at any time. It used to be fixed at creation with no way to move
   * it at all, which left a trans-health question filed under "General"
   * permanently invisible to everyone browsing for it, and the person who
   * mis-filed it with no recourse but to delete and repost (losing the replies).
   * The author's window is short because a category is also where a thread's
   * readers found it: moving one that has been up for a week moves it out from
   * under the people already talking in it, which is a moderator's call.
   *
   * All three fields are optional. Omitting `title` leaves it untouched (and
   * writes no edit revision); omitting `tags` leaves the tag set untouched,
   * while an explicit `[]` clears it; omitting `category` leaves it untouched.
   *
   * The title lives on the thread; edit-history is anchored to the OP post (the
   * `is_op` `ForumPost`), so a title change is snapshotted there with
   * `previousTitle` set. A tag or category move writes no revision, for the
   * reason given at `isTitleChanged` below.
   */
  async updateThread(
    slug: string,
    user: CurrentUserData,
    title?: string,
    tags?: string[],
    category?: string,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, user.userId);
    const isAuthor = thread.authorId === user.userId;
    const isModerator = isModeratorRole(user.role);
    if (title !== undefined && !isAuthor) {
      throw new ForbiddenException('Only the author can edit this thread');
    }
    if (tags !== undefined && !isAuthor && !isModerator) {
      throw new ForbiddenException(
        "Only the author or a moderator can edit this thread's tags",
      );
    }
    if (category !== undefined && !isAuthor && !isModerator) {
      throw new ForbiddenException(
        "Only the author or a moderator can change this thread's category",
      );
    }
    // The author's move window. A moderator is not bound by it, so this is
    // checked only when the caller is relying on authorship alone.
    if (
      category !== undefined &&
      !isModerator &&
      Date.now() - thread.createdAt.getTime() > CATEGORY_MOVE_WINDOW_MS
    ) {
      throw new ForbiddenException(
        'A thread can only be moved to another category in its first 24 hours. Ask a moderator to move it.',
      );
    }
    if (title === undefined && tags === undefined && category === undefined) {
      throw new BadRequestException('Nothing to update');
    }

    // The OP is the `is_op` post — one source of truth with every other path
    // (`resolveOp`/`toThreadResponses`/create), not a separate
    // oldest-by-`createdAt` lookup.
    const opPost = await this.posts.findOne({
      where: { threadId: thread.id, isOp: true },
    });
    // Snapshot the pre-edit title and persist the new one atomically: the edit
    // record, the OP post's `editedAt`, and the thread's title must all land
    // together, or a failure leaves a phantom revision for an edit that never
    // committed. `previousTitle` is captured before mutating `thread.title`.
    const previousTitle = thread.title;
    // A tags-only or category-only patch (the moderator/janitorial path) must
    // not stamp an edit revision on the OP: nothing about the post's words
    // changed, and an "edited" mark that appears because someone re-filed the
    // thread would be false on its face.
    const isTitleChanged = title !== undefined && title !== thread.title;
    if (title !== undefined) {
      thread.title = title;
    }
    // `tags` is an optional replacement set: only touch the column when the
    // caller sent the field (an explicit `[]` clears them; omitting it leaves
    // the existing tags untouched).
    if (tags !== undefined) {
      thread.tags = normalizeTags(tags);
    }
    // Moving the thread is a plain column write: the category is a free-text
    // filter key (`CreateThreadDto` validates its shape, `UpdateThreadDto`
    // repeats exactly the same rules including the reserved `"all"`), and the
    // per-category counts are computed from this column on every read rather
    // than denormalized, so nothing else has to be kept in step.
    if (category !== undefined) {
      thread.category = category;
    }
    await this.dataSource.transaction(async (manager) => {
      if (opPost && isTitleChanged) {
        await manager.save(
          manager.create(ForumPostEdit, {
            postId: opPost.id,
            previousBody: opPost.body,
            previousTitle,
            editorId: user.userId,
          }),
        );
        opPost.editedAt = new Date();
        await manager.save(opPost);
      }
      await manager.save(thread);
    });

    const authors = await new MemberLookup(this.profiles).byUserIds([
      thread.authorId,
    ]);
    // `opPost` (oldest post) is the OP; reuse it rather than a second lookup.
    const myVote = opPost
      ? ((
          await this.votes.findOne({
            where: { postId: opPost.id, userId: user.userId },
          })
        )?.value ?? 0)
      : 0;
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator },
      opPost,
      myVote,
      await this.subscriptions.isSubscribed(thread.id, user.userId),
    );
  }

  /**
   * DELETE /forum/threads/:slug — withdraw a whole thread (PRD-160).
   *
   * WHY THIS EXISTS. "Delete" in the forum used to reach the opening POST only.
   * The thread survived it: its full title stayed on /forum, in the per-category
   * counts and in every member's feed, behind a link that still worked, with
   * just the body replaced by "[deleted]". So a member who asked where to find
   * trans-affirming healthcare, or posted a housing ask they immediately
   * regretted, could blank the words and still watch the question itself
   * broadcast to the whole platform with their name on it. Withdrawing a
   * question has to withdraw the question.
   *
   * WHO. The author, or a platform Moderator/Admin. A moderator's delete is
   * recorded in `mod_audit_logs`; an author withdrawing their own thread is not
   * a moderation action and writes no audit row.
   *
   * WHAT IT TOUCHES. The thread's `deleted_at`/`deleted_by_id`, and the OP post
   * tombstoned exactly the way `ForumPostsService.tombstonePost` does it (same
   * two columns, same "don't overwrite an existing tombstone's actor" rule, so
   * a moderator takedown already on the OP keeps its own actor and stays
   * un-restorable by the author). REPLIES ARE LEFT ALONE: they are other
   * people's words, and the thread going out of every read path already takes
   * them out of view. Unlike `tombstonePost` this does not have to release an
   * accepted-answer mark, because the post being tombstoned here is the OP and
   * `setAcceptedPost` refuses to mark an OP in the first place.
   *
   * Idempotent: deleting an already-deleted thread writes nothing and echoes
   * the current state.
   */
  async deleteThread(
    slug: string,
    user: CurrentUserData,
  ): Promise<ForumThreadResponse> {
    const isModerator = isModeratorRole(user.role);
    // Loaded INCLUDING an already-deleted thread so a repeat delete is
    // idempotent rather than a puzzling 404, and with the community gate
    // bypassed for staff so a moderator can take down a thread in a Private
    // community they are not a member of (same posture as `setLocked`).
    const thread = await this.loadOr404(slug, user.userId, {
      includeDeleted: true,
      bypassCommunityAccess: isModerator,
    });
    const isAuthor = thread.authorId === user.userId;
    if (!isAuthor && !isModerator) {
      // A live thread gets the honest 403 every other forum write path gives.
      // An ALREADY-deleted one gets 404 instead: `loadOr404` hides deleted
      // threads from everyone but staff, and answering 403 here would tell a
      // stranger holding the slug that the thread exists and was withdrawn,
      // which is precisely the fact the delete was meant to retract.
      if (thread.deletedAt) {
        throw new NotFoundException('Thread not found');
      }
      throw new ForbiddenException(
        'Only the author or a moderator can delete this thread',
      );
    }

    if (!thread.deletedAt) {
      const deletedAt = new Date();
      // One transaction: a thread marked deleted whose OP still renders its
      // body, or an OP tombstoned under a thread that is still listed, are both
      // worse than either half not happening.
      await this.dataSource.transaction(async (manager) => {
        await manager.update(
          ForumThread,
          { id: thread.id },
          { deletedAt, deletedById: user.userId },
        );
        // `deletedAt: IsNull()` in the criteria, not just in the values: an OP a
        // moderator already took down keeps that moderator as its
        // `deleted_by_id`, so `ForumPostsService.assertCanRestore` still refuses
        // to let the author lift a staff takedown by deleting and restoring
        // their own thread.
        await manager.update(
          ForumPost,
          { threadId: thread.id, isOp: true, deletedAt: IsNull() },
          { deletedAt, deletedById: user.userId },
        );
      });
      thread.deletedAt = deletedAt;
      thread.deletedById = user.userId;
      // Only a moderator taking down somebody else's thread is a moderation
      // action. An author withdrawing their own is not, and an audit trail that
      // logged it would be a log of members changing their minds.
      if (isModerator && !isAuthor) {
        await this.auditThreadAction(
          user,
          THREAD_AUDIT_ACTIONS.deleted,
          thread,
        );
      }
    }

    const [authors, op, isSubscribed] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
      this.subscriptions.isSubscribed(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
    );
  }

  /**
   * POST /forum/threads/:slug/accepted-answer — mark (or clear) the reply that
   * answers this thread (SOC-13).
   *
   * Settable by the thread's AUTHOR, and by a platform Moderator/Admin. The
   * author is the person who knows which reply actually solved their problem;
   * a moderator can resolve a thread whose author has gone quiet, which is the
   * case that otherwise leaves a useful answer permanently unmarked.
   *
   * `postId` omitted/null clears the mark. Otherwise the post must belong to
   * THIS thread, must not be the opening post (a thread cannot answer itself),
   * and must not be tombstoned (nothing useful to point at).
   */
  async setAcceptedPost(
    slug: string,
    user: CurrentUserData,
    postId: string | null | undefined,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, user.userId);
    const isModerator = isModeratorRole(user.role);
    if (thread.authorId !== user.userId && !isModerator) {
      throw new ForbiddenException(
        'Only the thread author or a moderator can accept an answer',
      );
    }

    if (!postId) {
      thread.acceptedPostId = null;
    } else {
      const post = await this.posts.findOne({ where: { id: postId } });
      if (!post || post.threadId !== thread.id) {
        throw new NotFoundException('Post not found in this thread');
      }
      if (post.isOp) {
        throw new BadRequestException(
          'The opening post cannot be its own accepted answer',
        );
      }
      if (post.deletedAt) {
        throw new BadRequestException('A deleted post cannot be the answer');
      }
      thread.acceptedPostId = post.id;
    }
    await this.threads.save(thread);

    const [authors, op, isSubscribed] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
      this.subscriptions.isSubscribed(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
    );
  }

  /**
   * POST /forum/threads/:slug/follow | /unfollow — the manual Follow toggle
   * (SOC-13).
   *
   * Goes through `loadOr404` with the caller's id, so following a thread is
   * gated by exactly the same visibility rules as reading it: a private
   * community's thread cannot be followed by a non-member, and a blocked
   * author's thread cannot be followed at all. Idempotent in both directions.
   */
  async setSubscribed(
    slug: string,
    user: CurrentUserData,
    isSubscribed: boolean,
  ): Promise<ForumThreadResponse> {
    const thread = await this.loadOr404(slug, user.userId);
    if (isSubscribed) {
      await this.subscriptions.subscribe(thread.id, user.userId);
    } else {
      await this.subscriptions.unsubscribe(thread.id, user.userId);
    }

    const [authors, op] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
    );
  }

  /**
   * `GET /communities/:slug/pulse`'s threads lane — a community's own most
   * recent threads, newest-first. Reuses `toThreadResponses`' batched
   * author/OP/vote hydration (same shape the list/search views already
   * return) rather than inventing a lighter one. This method isn't called
   * with a specific viewer in mind (see `CommunityPulseService`, which calls
   * it once per pulse request for any roster member), so it passes a neutral
   * viewer — an empty `userId` can't match a real `authorId`/vote row, so
   * `canEdit`/`myVote`/the OP moderation flags all come back as their
   * "no permissions" defaults rather than leaking one viewer's affordances to
   * another.
   */
  async listRecentByCommunity(
    communityId: string,
    limit = 5,
  ): Promise<ForumThreadResponse[]> {
    const rows = await this.threads.find({
      // Withdrawn threads stay out of the community pulse too (PRD-160); this
      // lane has no viewer and so no staff view to preserve.
      where: { communityId, deletedAt: IsNull() },
      order: { createdAt: 'DESC' },
      take: limit,
    });
    if (!rows.length) return [];
    return this.toThreadResponses(rows, '', false);
  }

  // --- internals ---

  private async createWithUniqueSlug(
    authorId: string,
    input: CreateThreadInput,
    communityId: string | null = null,
  ): Promise<{ thread: ForumThread; opPost: ForumPost }> {
    for (let attempt = 1; attempt <= MAX_SLUG_ATTEMPTS; attempt++) {
      const slug = await allocateUniqueSlug(
        slugify(input.title, 'thread'),
        (s) => this.threads.exists({ where: { slug: s } }),
      );

      try {
        return await this.dataSource.transaction(async (manager) => {
          const threadsRepo = manager.getRepository(ForumThread);
          const postsRepo = manager.getRepository(ForumPost);

          const now = new Date();
          const thread = await threadsRepo.save(
            threadsRepo.create({
              slug,
              title: input.title,
              authorId,
              category: input.category,
              isPinned: false,
              isLocked: false,
              isOfficial: input.isOfficial ?? false,
              tags: normalizeTags(input.tags),
              communityId,
              // Explicit 0 (not just the DB default) so the create echo returns
              // a number even before a reload — the OP starts with no votes.
              opVoteCount: 0,
              replyCount: 0,
              lastActivityAt: now,
            }),
          );

          const opPost = await postsRepo.save(
            postsRepo.create({
              threadId: thread.id,
              authorId,
              body: input.body,
              image: input.image ?? null,
              voteCount: 0,
              // Mark this as the thread's opening post: lets the list page
              // batch-load every OP in one `WHERE is_op AND thread_id IN (...)`
              // query and lets `ForumPostsService.vote` mirror the OP's count
              // onto `forum_thread.op_vote_count`.
              isOp: true,
            }),
          );

          return { thread, opPost };
        });
      } catch (err) {
        if (isUniqueViolation(err) && attempt < MAX_SLUG_ATTEMPTS) {
          continue; // lost the slug race — regenerate and retry
        }
        throw err;
      }
    }
    // Unreachable: the loop either returns a saved thread or rethrows.
    throw new ConflictException('Could not allocate a unique thread slug');
  }

  // Takes withdrawn threads out of a browse/count/search query (PRD-160).
  // Platform staff keep seeing them, so a report filed against a thread its
  // author then deleted is still reviewable and the moderation queue does not
  // fill with rows that lead nowhere. Expressed as a filter on the query rather
  // than a post-fetch drop for the same reason the block filter is: filtering
  // after a fixed-size fetch under-fills the page.
  private excludeDeletedThreads(
    qb: SelectQueryBuilder<ForumThread>,
    viewerIsModerator: boolean,
  ): void {
    if (viewerIsModerator) return;
    qb.andWhere('t.deleted_at IS NULL');
  }

  // Folds the text (`q`) and tag (`:tag = ANY(t.tags)`) filters onto a query
  // builder. Shared by `list()` + `counts()` so both narrow the visible set
  // identically — that shared narrowing is the whole point of the helper, since
  // a category badge counting threads the list will not draw is worse than no
  // badge. Both filters are no-ops when their term is empty.
  //
  // `q` matches the thread TITLE OR THE BODY OF ANY VISIBLE POST in the thread
  // (C9/PRD-164). It used to be `title ILIKE` alone, which meant the forum's own
  // search box could not find a question that was answered in a reply: someone
  // searching "HRT clinic Lisbon" got nothing, while the global search bar (a
  // different code path, `ForumPostsService.searchByText`) found the reply that
  // said exactly that. The forum's own box has to be at least as good as the
  // one in the header.
  //
  // Written as a correlated EXISTS rather than a join so it stacks cleanly onto
  // the keyset ORDER BY without multiplying thread rows per matching reply
  // (mirroring `applyCommunityAccessFilter`). Backed by
  // `IDX_forum_post_body_trgm` (see `AddForumThreadTopKeysetAndReplySearch`),
  // since a leading-wildcard ILIKE is unservable by a btree.
  private applyTextAndTagFilters(
    qb: SelectQueryBuilder<ForumThread>,
    q: string | undefined,
    tag: string | undefined,
  ): void {
    const term = q?.trim();
    if (term) {
      // `escapeLikeTerm` neutralizes `%`/`_` so they match literally. One bound
      // parameter feeds both branches.
      qb.andWhere(
        `(
          t.title ILIKE :forumSearchPattern
          OR EXISTS (
            SELECT 1 FROM "forum_post" "__search_post"
            WHERE "__search_post"."thread_id" = t.id
              AND "__search_post"."deleted_at" IS NULL
              AND "__search_post"."body" ILIKE :forumSearchPattern
              AND NOT EXISTS (
                SELECT 1 FROM "content_moderation" "__search_post_moderation"
                WHERE "__search_post_moderation"."subject_type" IN (:...forumSearchSubjectTypes)
                  AND "__search_post_moderation"."subject_id" = "__search_post"."id"::text
                  AND (
                    "__search_post_moderation"."hidden_at" IS NOT NULL
                    OR "__search_post_moderation"."removed_at" IS NOT NULL
                  )
              )
          )
        )`,
        {
          forumSearchPattern: `%${escapeLikeTerm(term)}%`,
          // A tombstoned post keeps its body only so it can be restored, and a
          // post a moderator hid or removed is text that was deliberately taken
          // down. Either one matching would make this filter an oracle: type a
          // phrase, see whether a thread comes back, learn what the removed post
          // said. `ForumPostsService.searchByText` excludes both for exactly
          // this reason and this stays in step with it.
          forumSearchSubjectTypes: OP_MODERATION_SUBJECT_TYPES,
        },
      );
    }
    const normalizedTag = tag ? normalizeTag(tag) : '';
    if (normalizedTag) {
      qb.andWhere(':tag = ANY(t.tags)', { tag: normalizedTag });
    }
  }

  // Narrows a thread list/count query to the threads a given viewer may see by
  // community access tier: a thread scoped to a Private community only stays
  // in the result set for a viewer on that community's roster. Threads with a
  // null `community_id` (flat/global) and threads in non-Private communities
  // (public/request/invite) stay visible to everyone — the same set
  // `CommunityPostsService.assertViewable` and the `community_post` feed branch
  // admit. Expressed as correlated EXISTS subqueries (not a join) so it stacks
  // cleanly onto `cursorPaginate`'s keyset ORDER BY, mirroring
  // `FeedService.fetchCandidates`. Shared by `list`/`counts`/`listPinned`/
  // `searchByText` so every browse/search surface hides the same threads.
  private applyCommunityAccessFilter(
    qb: SelectQueryBuilder<ForumThread>,
    viewerId: string,
  ): void {
    qb.andWhere(
      `(
        t.community_id IS NULL
        OR EXISTS (
          SELECT 1 FROM "communities" "com"
          WHERE "com"."id" = t.community_id
            AND "com"."access_tier" != :privateTier
        )
        OR EXISTS (
          SELECT 1 FROM "community_members" "mem"
          WHERE "mem"."community_id" = t.community_id
            AND "mem"."user_id" = :viewerId
        )
      )`,
      { privateTier: AccessTier.Private, viewerId },
    );
  }

  // Single-thread counterpart to `applyCommunityAccessFilter`, used by
  // `loadOr404`: true only when the thread's community is Private AND the
  // viewer isn't on its roster — the exact condition
  // `CommunityPostsService.assertViewable` 404s on. Non-Private tiers
  // (public/request/invite) are readable by non-members, same as community
  // posts, so they never hide a thread. Runs against the `communities` entity
  // via the thread repo's shared entity manager, so `ForumModule` needs no
  // extra `Community` repository registration.
  private async isCommunityHiddenFrom(
    communityId: string,
    viewerId: string,
  ): Promise<boolean> {
    return this.threads.manager
      .createQueryBuilder(Community, 'com')
      .where('com.id = :communityId', { communityId })
      .andWhere('com.accessTier = :privateTier', {
        privateTier: AccessTier.Private,
      })
      .andWhere(
        `NOT EXISTS (
          SELECT 1 FROM "community_members" "mem"
          WHERE "mem"."community_id" = com.id
            AND "mem"."user_id" = :viewerId
        )`,
        { viewerId },
      )
      .getExists();
  }

  // Maps a `sort` to its `cursorPaginate` keyset. `active` swaps the leading
  // column (DESC, `id` tie-break); `new`/`unanswered` return undefined so the
  // default `(createdAt, id)` keyset is used. `top` never reaches here: it has
  // three sort columns and a recency window, so `list` routes it to
  // `paginateTop` instead. Column exprs + their backing DESC indexes are
  // documented on the `ForumThread` entity.
  //
  // AN OMITTED SORT MEANS `active`. The server used to default to `new` while
  // the frontend defaulted to `top`, so an unparameterised call answered a
  // question nobody had asked. `active` is the sensible answer to "just show me
  // the forum" and it is what the frontend now sends too (PRD-161).
  //
  // `last_activity_at` is a MUTABLE sort key (a reply changes a thread's
  // position mid-scroll), so the keyset can skip or repeat a thread across page
  // boundaries as it moves. That trade-off is intentional and accepted for
  // infinite scroll — the alternative (a stable snapshot cursor) is not worth
  // the complexity here.
  private keysetForSort(
    sort: ThreadSort | undefined,
  ): CursorKeyset<ForumThread> | undefined {
    if (sort === 'active' || sort === undefined) {
      return {
        columnExpr: '"t"."last_activity_at"',
        direction: 'DESC',
        kind: 'date',
        getValue: (row) => row.lastActivityAt,
      };
    }
    return undefined;
  }

  /**
   * How many replies have landed in each thread since the viewer last opened it
   * (C7/PRD-170). One query for the whole page, never a probe per row.
   *
   * A thread is absent from the returned map whenever there is nothing to
   * count against: no viewer, no subscription row, or a row whose
   * `last_read_at` is still NULL because the member has never opened the
   * thread. `toForumThreadResponse` renders that absence as `null`, which is a
   * different statement from `0` ("opened, nothing new since") and is why the
   * two cases are kept apart all the way to the client.
   *
   * LEFT JOIN, not an inner one, for exactly that distinction: a thread the
   * member HAS opened and where nothing has landed since must come back as `0`,
   * and an inner join would drop it and make it indistinguishable from a thread
   * they have never opened. Which is why the reply predicates live in the ON
   * clause rather than the WHERE: in a WHERE they would turn the outer join
   * back into an inner one.
   *
   * WHAT IS COUNTED. Replies only (`is_op = false`), still standing
   * (`deleted_at IS NULL`), written by somebody else, and by somebody the
   * viewer has not blocked or muted. Each exclusion is there so the badge
   * cannot promise a reply the thread page will not draw: the member's own
   * replies are not news to them, a withdrawn reply is a tombstone, and a muted
   * author's replies are filtered out of `listPosts` too. A badge that says
   * "2 new" and opens onto nothing is worse than no badge.
   *
   * Moderator-hidden replies are deliberately NOT excluded here. That would
   * mean a correlated lookup into `content_moderation` for every reply in the
   * window on every list page, to correct a count by the handful of posts under
   * an active takedown; the overcount is bounded, rare, and self-healing the
   * moment the member opens the thread.
   *
   * Capped at `UNREAD_REPLY_COUNT_CAP` in SQL rather than in the mapper so the
   * cap is part of the one number that crosses the wire.
   */
  private async unreadReplyCountsByThread(
    threadIds: string[],
    viewerId: string,
  ): Promise<Map<string, number>> {
    if (!viewerId || !threadIds.length) return new Map();
    const rows = await this.threads.manager.query<
      Array<{ thread_id: string; unread_count: string }>
    >(
      `SELECT "watermark"."thread_id" AS "thread_id",
              LEAST(COUNT("p"."id"), $3::int) AS "unread_count"
         FROM "forum_thread_subscription" "watermark"
         LEFT JOIN "forum_post" "p"
           ON "p"."thread_id" = "watermark"."thread_id"
          AND "p"."created_at" > "watermark"."last_read_at"
          AND "p"."deleted_at" IS NULL
          AND "p"."is_op" = false
          AND "p"."author_id" <> $1
          AND NOT EXISTS (
                SELECT 1 FROM "blocks" "__unread_block"
                 WHERE ("__unread_block"."blocker_id" = $1 AND "__unread_block"."blocked_id" = "p"."author_id")
                    OR ("__unread_block"."blocked_id" = $1 AND "__unread_block"."blocker_id" = "p"."author_id")
              )
          AND NOT EXISTS (
                SELECT 1 FROM "mutes" "__unread_mute"
                 WHERE "__unread_mute"."muter_id" = $1
                   AND "__unread_mute"."muted_id" = "p"."author_id"
              )
        WHERE "watermark"."user_id" = $1
          AND "watermark"."last_read_at" IS NOT NULL
          AND "watermark"."thread_id" = ANY($2::uuid[])
        GROUP BY "watermark"."thread_id"`,
      [viewerId, threadIds, UNREAD_REPLY_COUNT_CAP],
    );
    return new Map(
      rows.map((row) => [row.thread_id, Number(row.unread_count)]),
    );
  }

  // Resolves a single thread's OP post, the viewer's vote on it, and the OP's
  // moderation state, for the single-thread echoes (getBySlug/lock/delete) that
  // don't run through the batched `toThreadResponses`. Three point lookups, the
  // last two in parallel; `null`/0/visible when the OP is missing. The caller
  // derives `opPostId`, the OP card flags and `excerpt` from what comes back.
  private async resolveOp(
    threadId: string,
    viewerId: string,
  ): Promise<{
    opPost: ForumPost | null;
    myVote: number;
    moderation: ContentModerationState;
  }> {
    const op = await this.posts.findOne({ where: { threadId, isOp: true } });
    if (!op) {
      return { opPost: null, myVote: 0, moderation: OP_NOT_MODERATED };
    }
    const [vote, moderationStates] = await Promise.all([
      this.votes.findOne({ where: { postId: op.id, userId: viewerId } }),
      // PRD-167 — the card now quotes the OP body, so it has to know whether a
      // moderator took that body down before it does.
      this.contentModeration.statesForAnyType(OP_MODERATION_SUBJECT_TYPES, [
        op.id,
      ]),
    ]);
    return {
      opPost: op,
      myVote: vote?.value ?? 0,
      moderation: moderationStates.get(op.id) ?? OP_NOT_MODERATED,
    };
  }

  // Batched mapping for a page of threads. A fixed number of queries regardless
  // of page size (no N+1): authors, the page's OP posts
  // (`WHERE is_op AND thread_id IN (...)`), the viewer's subscriptions, the
  // viewer's votes on those OP posts (`WHERE user_id = viewer AND post_id IN
  // (opIds)`) and the OPs' moderation states, the last two in parallel.
  // `opPostId`/`myVote`/`excerpt` are threaded into each response;
  // `opVoteCount`/`tags` ride on the row.
  private async toThreadResponses(
    rows: ForumThread[],
    viewerId: string,
    viewerIsModerator: boolean,
  ): Promise<ForumThreadResponse[]> {
    if (!rows.length) return [];
    const viewer: ForumThreadViewer = {
      userId: viewerId,
      isModerator: viewerIsModerator,
    };
    const authorIds = [...new Set(rows.map((t) => t.authorId))];
    const threadIds = rows.map((t) => t.id);

    const [authors, opPosts, subscribedThreadIds, unreadByThread] =
      await Promise.all([
        new MemberLookup(this.profiles).byUserIds(authorIds),
        this.posts.find({ where: { isOp: true, threadId: In(threadIds) } }),
        // One `user_id = :viewer AND thread_id IN (...)` query for the whole
        // page, never a per-row existence probe.
        this.subscriptions.subscribedThreadIds(threadIds, viewerId),
        // Same rule for the unread badge (C7/PRD-170): one grouped count across
        // the page, not one per row.
        this.unreadReplyCountsByThread(threadIds, viewerId),
      ]);
    const opByThread = new Map(opPosts.map((post) => [post.threadId, post]));

    const opIds = opPosts.map((post) => post.id);
    // Both keyed on the SAME id list, so they go out together rather than one
    // after the other. `opModerationStates` is what keeps a hidden or removed
    // OP's words out of the page's excerpts (PRD-167).
    const [myVoteRows, opModerationStates] = opIds.length
      ? await Promise.all([
          this.votes.find({ where: { postId: In(opIds), userId: viewerId } }),
          this.contentModeration.statesForAnyType(
            OP_MODERATION_SUBJECT_TYPES,
            opIds,
          ),
        ])
      : [[], new Map<string, ContentModerationState>()];
    const myVoteByPost = new Map(
      myVoteRows.map((row) => [row.postId, row.value]),
    );

    return rows.map((t) => {
      const op = opByThread.get(t.id) ?? null;
      return toForumThreadResponse(
        t,
        authors.get(t.authorId) ?? null,
        viewer,
        op,
        op ? (myVoteByPost.get(op.id) ?? 0) : 0,
        subscribedThreadIds.has(t.id),
        op ? (opModerationStates.get(op.id) ?? OP_NOT_MODERATED) : undefined,
        // Absent from the map = no watermark for this viewer on this thread,
        // which is `null` (no unread information), never 0.
        unreadByThread.get(t.id) ?? null,
      );
    });
  }
}
