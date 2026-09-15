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
import { MemberLookup, MemberRef } from '../common/member-ref';
import { allocateUniqueSlug, slugify } from '../common/slug.util';
import { MentionNotificationService } from '../mentions/mention-notification.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { isGatedTier } from '../communities/community-gate';
import {
  ContentModerationService,
  ContentModerationState,
} from '../content-moderation/content-moderation.service';
import { ModAuditService } from '../moderation/mod-audit.service';
import { NotificationType } from '../notifications/entities/notification.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { TopicPostLinkService } from '../content/topic-post-link.service';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserRole } from '../users/entities/user.entity';
import { ForumSubscriptionsService } from './forum-subscriptions.service';
import { CreateThreadPollDto } from './dto/create-thread-poll.dto';
import { ForumPostPhotoDto } from './dto/forum-post-photo.dto';
import { ForumPostEdit } from './entities/forum-post-edit.entity';
import { ForumPostPhoto } from './entities/forum-post-photo.entity';
import { ForumPostVote } from './entities/forum-post-vote.entity';
import { ForumPost } from './entities/forum-post.entity';
import { ForumThread } from './entities/forum-thread.entity';
import {
  ResolvedPollInput,
  insertThreadPoll,
  pollViewsByThread,
  resolvePollLabels,
} from './forum-poll';
import {
  PostPhotoInput,
  assertSinglePhotoSpelling,
  insertPostPhotos,
  normalizePostPhotos,
  photoRowsByPost,
} from './forum-post-photo';
import {
  ForumPollView,
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
  /**
   * Skip the scheduled/under-review gate (`isThreadPublished`), for the staff
   * and admin entry points that must reach a thread no member can see yet: the
   * moderator detail read, lock/pin/official/delete, and the post list behind
   * them. The thread's own AUTHOR needs no flag — `assertVisibleOr404` lets
   * them past the gate on their own rows.
   */
  includeUnpublished?: boolean;
}

const DEFAULT_LIMIT = 20;
const MAX_SLUG_ATTEMPTS = 5;
const MAX_TAGS = 5;
// Cap on simultaneously pinned threads — mirrors
// `ConversationsService.MAX_PINNED_CONVERSATIONS`, enforced the same way (an
// application-code count check in `setPinned`, not a DB constraint).
const MAX_PINNED_THREADS = 3;

// Content warnings a thread may carry. Matches `CreateThreadDto`'s
// `@ArrayMaxSize(8)`; repeated here because this is what actually trims the
// stored array, the way `MAX_TAGS` does for `tags`.
const MAX_CONTENT_WARNINGS = 8;

// The categories where an anonymous byline is allowed at all (server-enforced;
// see `CreateThreadDto.isAnonymous`). These are the three where anonymity is
// the difference between asking and not asking: a health question, a housing
// ask, a trans-specific thread. Everywhere else `isAnonymous` coerces to false,
// because an anonymous byline on a general thread costs the forum
// accountability and buys the author nothing they needed.
const ANONYMOUS_CATEGORIES: readonly string[] = ['health', 'housing', 'trans'];

// How far ahead `publishAt`/`closesAt` may be set. A deadline or an embargo
// further out than a year is not a schedule, and the ceiling is what stops a
// mistyped year from parking a thread in the next century where nobody will
// ever see it fire.
const MAX_SCHEDULE_AHEAD_MS = 365 * 24 * 60 * 60 * 1000;

// `forum_thread.review_state` values. NULL (never submitted) is the fourth
// state and deliberately has no constant: it is the ABSENCE of a review, not a
// value, and every read path spells it `IS NULL`.
const REVIEW_STATE_PENDING = 'pending';
const REVIEW_STATE_APPROVED = 'approved';
// A thread a reviewer turned down. It fails the read gate exactly as `pending`
// does, so the thread stays reachable by its author and by staff and by nobody
// else; nothing is deleted, which is what makes a rejection reversible by a
// human rather than by a restore.
const REVIEW_STATE_REJECTED = 'rejected';

/**
 * THE member-facing thread read gate, as ONE verbatim SQL string.
 *
 * Two facts hide a thread from everybody but its author and the moderators: it
 * is scheduled for later (`published_at` in the future), or it is waiting on an
 * editorial/council review that has not approved it (`review_state` is
 * 'pending' or 'rejected'). NULL `review_state` means NEVER SUBMITTED, which is
 * the state of nearly every thread on the forum and is VISIBLE — see
 * `ForumThread.reviewState`.
 *
 * WHY THIS IS A CONSTANT AND WHY ITS TEXT IS FROZEN.
 * `AddForumRichComposer1817300000000` rebuilt both hot keyset indexes
 * (`IDX_forum_thread_visible_top_keyset`,
 * `IDX_forum_thread_visible_unanswered_created_at_id`) as PARTIAL indexes whose
 * predicates contain `(review_state IS NULL OR review_state = 'approved')`
 * written exactly that way. Postgres proves an OR predicate by matching each
 * query arm against a predicate arm, so a logically equivalent rewrite —
 * `review_state IS DISTINCT FROM 'pending'`, `COALESCE(review_state,
 * 'approved') = 'approved'`, the arms reordered, or the arms split across two
 * `andWhere` calls — does NOT match, and the `top` and `unanswered` sorts
 * silently lose their seek. One exported constant, emitted through one
 * `andWhere`, is what stops the two spellings from drifting apart across five
 * call sites.
 *
 * `published_at <= now()` rides in the SAME string but is NOT in either index
 * predicate, and cannot be: index predicates must be IMMUTABLE and `now()` is
 * STABLE, so Postgres rejects it outright. It stays a filter on the rows the
 * seek already returned, which is cheap for the right reason — the rows it
 * removes are the scheduled-future tail, clustered at the newest end of both
 * sorts. It leads the string rather than trailing it only because it is the
 * cheaper test; the disjunction behind it is untouched either way.
 */
export const FORUM_THREAD_VISIBLE_SQL = forumThreadVisibleSql('t');

/**
 * The same gate for a query builder running under a DIFFERENT alias.
 *
 * The frozen text above is frozen in its ARMS and their ORDER, which is what
 * the planner's predicate prover matches on; the alias qualifying each column
 * is not part of that and cannot be, since it is whatever the caller named
 * their builder. So this is one template emitting one spelling, and
 * `FORUM_THREAD_VISIBLE_SQL` is that template applied to the forum's own `t` —
 * which is deliberately NOT the same thing as running the finished string
 * through a rewrite (read the docstring above for why one must never do that).
 *
 * `SavedAvailabilityService.resolveThreads` is why this exists. That service
 * re-applies every forum read predicate by hand for bookmarked threads (its own
 * comment says "predicate for predicate") and had already fallen behind this
 * gate, so a bookmarked thread that was scheduled or waiting on a review could
 * still surface a title on a saved list. It now calls this instead of writing a
 * third spelling that can fall behind again.
 */
export function forumThreadVisibleSql(alias: string): string {
  return `${alias}.published_at <= now() AND (${alias}.review_state IS NULL OR ${alias}.review_state = 'approved')`;
}

/**
 * The single-row twin of `FORUM_THREAD_VISIBLE_SQL`, for the by-slug/by-id
 * reads that hold a loaded thread rather than a query builder
 * (`assertVisibleOr404`).
 *
 * Kept as a hand-written mirror rather than generated from the SQL on purpose:
 * the SQL's text is frozen for the planner's sake (see above), and running it
 * through any transformation to produce this is exactly the kind of cleverness
 * that would eventually rewrite the frozen string. The two are short, they sit
 * next to each other, and a spec pins them together.
 */
export function isThreadPublished(
  // A `Pick`, not a whole `ForumThread`, for one caller: `create` has to know
  // whether the thread it is about to insert will be visible BEFORE the row
  // exists, so it can decide between fanning out inline and deferring. Asking
  // the same function rather than restating the two conditions there is what
  // keeps the predicate single.
  thread: Pick<ForumThread, 'publishedAt' | 'reviewState'>,
): boolean {
  const reviewState = thread.reviewState ?? null;
  return (
    thread.publishedAt.getTime() <= Date.now() &&
    (reviewState === null || reviewState === REVIEW_STATE_APPROVED)
  );
}

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

// The access tiers whose content is closed to anyone off the community's
// roster, i.e. everything but `public`. Derived from `isGatedTier` rather than
// listed by hand so the forum's read gates and the community gate itself can
// never disagree about which tiers are closed, and so a tier added later is
// gated until somebody deliberately opens it. Used by `isCommunityHiddenFrom`,
// whose sense is inverted and so needs the closed tiers rather than `public`.
const GATED_ACCESS_TIERS: readonly AccessTier[] =
  Object.values(AccessTier).filter(isGatedTier);

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
  // The moderator review verdict. Audited like every other staff action on a
  // thread, and more than most of them need to be: an approval is what puts a
  // thread in front of the whole forum, and a rejection is what keeps it from
  // ever getting there, so both are decisions an appeal has to be able to find.
  reviewApproved: 'thread_review_approved',
  reviewRejected: 'thread_review_rejected',
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

// Normalizes author-supplied content warnings for storage: trim, drop empties,
// dedupe (first-wins, case-insensitively), cap at `MAX_CONTENT_WARNINGS`.
//
// Deliberately NOT lowercased the way `normalizeTags` lowercases tags. A tag is
// a filter KEY and has to match `:tag = ANY(t.tags)` exactly, so its case has to
// be flattened; a content warning is a LABEL a reader reads, nothing queries
// across them, and flattening "HRT" to "hrt" would only make it harder to read.
// Deduping still ignores case, so a composer sending both spellings stores one.
function normalizeContentWarnings(warnings: string[] | undefined): string[] {
  if (!warnings) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of warnings) {
    const warning = raw.trim();
    const key = warning.toLowerCase();
    if (!warning || seen.has(key)) continue;
    seen.add(key);
    out.push(warning);
    if (out.length >= MAX_CONTENT_WARNINGS) break;
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
  /** 'question' | 'guide' | 'proposal' | 'share'; omitted = unclassified. */
  kind?: string;
  /** Author-chosen warnings, normalized by `normalizeContentWarnings`. */
  contentWarnings?: string[];
  /**
   * Requested anonymity. NOT what gets stored: `create` coerces it to false
   * outside `ANONYMOUS_CATEGORIES` and whenever `isOfficial` wins.
   */
  isAnonymous?: boolean;
  /** A second member to credit, by handle. Resolved to a user id in `create`. */
  coAuthorHandle?: string;
  /** Free-text neighbourhood the thread is about. */
  neighbourhood?: string;
  /** 'pt' | 'en' | 'both'; omitted = unstated. */
  language?: string;
  /** Requested cross-post. Coerced to false without a `communitySlug`. */
  crossPosted?: boolean;
  /** ISO-8601; when the thread stops taking replies. Window checked in `create`. */
  closesAt?: string;
  /** ISO-8601; a scheduled publish. Maps to `publishedAt`, `now()` when absent. */
  publishAt?: string;
  /** Create the thread with `reviewState: 'pending'` instead of publishing it. */
  submitForReview?: boolean;
  /** An optional poll, 2-6 options. Validated by `resolvePollLabels` in `create`. */
  poll?: CreateThreadPollDto;
  /** Up to four photos on the opening post, in the author's order. */
  photos?: ForumPostPhotoDto[];
}

/**
 * The half of a new thread that `create` has already resolved, coerced or
 * rejected before the insert transaction opens.
 *
 * Separate from `CreateThreadInput` because these are not what the CALLER sent:
 * `isAnonymous` here is the flag after the category and `isOfficial` rules ran,
 * `coAuthorId` is a resolved user id rather than the handle that was posted, and
 * the two dates have been parsed and window-checked. Keeping them in their own
 * shape is what stops `createWithUniqueSlug` from having to remember which
 * fields of `input` it may trust.
 */
interface ResolvedThreadFields {
  isOfficial: boolean;
  isAnonymous: boolean;
  crossPosted: boolean;
  coAuthorId: string | null;
  publishedAt: Date;
  reviewState: string | null;
  closesAt: Date | null;
  /**
   * The create fan-out mark the row is INSERTED with: `now()` for a thread that
   * is visible the moment it commits (the insert is its own claim — no other
   * request can be racing for a row that does not exist yet), `null` for a
   * scheduled or pending-review thread, whose fan-out is owed and will be
   * claimed later by `publishThread`. See `ForumThread.fannedOutAt`.
   */
  fannedOutAt: Date | null;
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
    // The author's own word on a review verdict. `NotificationsModule` does not
    // import `ForumModule`, so this is a plain import with no `forwardRef` —
    // same shape as every other module that reaches it.
    private readonly notifications: NotificationsService,
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
    // A gated community's threads never enter a non-member's browse list (H1).
    // Every tier but `public` is gated, and this is the same gate `loadOr404`
    // and the feed apply, so the list cannot leak a thread the detail read
    // would 404.
    this.applyCommunityAccessFilter(qb, viewerId);
    // A withdrawn thread leaves the browse list for everyone but staff
    // (PRD-160), before any of the narrowing below, so the same set every other
    // read path admits is the set the page is drawn from.
    this.excludeDeletedThreads(qb, viewerIsModerator);
    // A thread scheduled for later, or waiting on a review, is not part of what
    // the forum is showing yet. Folded on HERE, before the sort branches, so
    // both keyset paths inherit it: `cursorPaginate`'s seek and `paginateTop`'s
    // (including the window-size count it runs on a clone of this builder).
    this.applyPublishedThreadGate(qb, viewerIsModerator);
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
    // Same gated-community gate as `list` (H1) so the category badges never
    // count threads the viewer can't open.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Same soft-delete gate as `list` (PRD-160): a badge that counts a
    // withdrawn thread promises a row the list will not draw, and the count is
    // itself a leak — "this category has one more thread than you can see".
    this.excludeDeletedThreads(qb, viewerIsModerator);
    // And the same scheduled/under-review gate, for exactly that reason: a
    // badge counting a thread nobody can open is both a broken promise and a
    // leak ("something is pending in health").
    this.applyPublishedThreadGate(qb, viewerIsModerator);
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
      // Same posture for a scheduled or under-review thread: a moderator who
      // has to lock one before it lands must be able to reach it.
      includeUnpublished: true,
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
    const [byline, op] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
    ]);
    // The role gate above already proved the caller is a moderator.
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
      // Same for the unread badge: nothing here resolves a watermark, and null
      // is "no unread information", never "nothing new".
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
      // And a scheduled one, so a thread can be pinned ahead of its own
      // publish instant rather than only after it lands.
      includeUnpublished: true,
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
    const [byline, op] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
    ]);
    // The role gate above already proved the caller is a moderator.
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
      // Same for the unread badge: nothing here resolves a watermark, and null
      // is "no unread information", never "nothing new".
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
      // Admin-only route; a withdrawn thread stays reachable (PRD-160), and so
      // does a scheduled or under-review one.
      includeDeleted: true,
      includeUnpublished: true,
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
    const [byline, op] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      // These staff echoes have never resolved the caller's own subscription
      // (a moderator locking a thread is rarely following it); passed
      // explicitly now only because `opModeration` sits behind it.
      false,
      op.moderation,
      // Same for the unread badge: nothing here resolves a watermark, and null
      // is "no unread information", never "nothing new".
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
    // Same gated-community gate as `list` (H1): a pinned thread in a gated
    // community stays out of a non-member's sticky bucket.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Same soft-delete gate as `list` (PRD-160). A pinned thread that is later
    // withdrawn would otherwise be the loudest row on the page.
    this.excludeDeletedThreads(qb, viewerIsModerator);
    // Same scheduled/under-review gate, and the sticky bucket is where it
    // matters most: a pinned thread is the loudest row on the page, so one
    // published a week early is the most visible mistake the composer can make.
    this.applyPublishedThreadGate(qb, viewerIsModerator);
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
  // type. Reuses the same block filter and gated-community gate as `list()`.
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
    // Same gated-community gate as `list` (H1): global search must not
    // surface a gated community's thread titles to a non-member, on any tier
    // but `public`.
    this.applyCommunityAccessFilter(qb, viewerId);
    // Withdrawn threads leave global search too (PRD-160), unconditionally: the
    // caller (`SearchService`) carries only the viewer's id and this path
    // already treats every viewer as a non-moderator (see the `false` passed to
    // `toThreadResponses` below), so there is no staff view to preserve here.
    this.excludeDeletedThreads(qb, false);
    // Same for scheduled and under-review threads, and unconditionally for the
    // same reason: this caller carries only a viewer id and already treats every
    // viewer as a non-moderator. A search box that returns the TITLE of a
    // pending guide has published it.
    this.applyPublishedThreadGate(qb, false);
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
    // A non-member reading a gated community's thread by slug 404s (H1), on
    // every tier but `public`; a platform moderator bypasses so they can still
    // open a reported thread.
    const thread = await this.loadOr404(slug, viewerId, {
      bypassCommunityAccess: viewerIsModerator,
      // Direct navigation to a withdrawn thread 404s for everybody but staff
      // (PRD-160), who keep the detail view so a report against it stays
      // reviewable.
      includeDeleted: viewerIsModerator,
      // Likewise a scheduled or under-review thread. Note there is no author
      // flag to pass: `assertVisibleOr404` already lets a member past this gate
      // on their OWN rows, so an author can open the thread they scheduled.
      includeUnpublished: viewerIsModerator,
    });
    const [byline, op, isSubscribed, unreadByThread] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, viewerId, viewerIsModerator),
      this.subscriptions.isSubscribed(thread.id, viewerId),
      // Read BEFORE the member's own `POST /threads/:slug/read` lands, which is
      // the point: this is the count of what arrived while they were away, and
      // the thread page uses it to mark where they left off.
      this.unreadReplyCountsByThread([thread.id], viewerId),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: viewerId, isModerator: viewerIsModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
      unreadByThread.get(thread.id) ?? null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
   * stamped on a thread the member could actually read: a gated community's
   * thread, a blocked author's thread and a withdrawn thread all 404 here
   * exactly as they do everywhere else.
   *
   * Returns `{ ok: true }` rather than the thread. It fires on every thread
   * open, the client already holds the thread it just rendered, and the only
   * field the stamp changes is the one the client is about to clear anyway.
   */
  async markRead(slug: string, user: CurrentUserData): Promise<{ ok: true }> {
    // A moderator never meets the scheduled/under-review gate, here or anywhere
    // else: they can open the thread, so stamping where they got to must not
    // 404. The author passes on their own rows without a flag.
    const thread = await this.loadOr404(slug, user.userId, {
      includeUnpublished: isModeratorRole(user.role),
    });
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
    // Anonymity is coerced the same way, against two rules. It is allowed only
    // in the categories where it is the difference between asking and not
    // asking, and `isOfficial` wins outright when both arrive: the platform
    // speaking under its own name and a member hiding theirs are opposite acts,
    // so a row claiming both is resolved HERE rather than left for the mapper
    // (which resolves it again anyway, since an admin can flip `isOfficial` on
    // afterwards and the database has no constraint to appeal to).
    const isAnonymous =
      !isOfficial &&
      !!input.isAnonymous &&
      ANONYMOUS_CATEGORIES.includes(input.category.trim().toLowerCase());
    // Cross-posting means "this community's thread ALSO shows in the town
    // square", so it says nothing about a thread that belongs to no community —
    // that thread is already there. Coerced off rather than 400'd, matching
    // `isOfficial`: it is a checkbox only the community composer shows.
    const crossPosted = communityId != null && !!input.crossPosted;
    // The three that can REJECT the request, resolved before the transaction
    // opens so a bad handle or a date in the past costs no insert. Mirrors the
    // community resolution above.
    const coAuthorId = await this.resolveCoAuthorId(
      input.coAuthorHandle,
      authorId,
    );
    // No `publishAt` means publish now. The column has no database default on
    // purpose (a `DEFAULT now()` would silently publish a scheduled thread the
    // moment an insert forgot the column), so this is the one place that
    // decides it.
    const publishedAt =
      this.parseScheduledInstant(input.publishAt, 'publishAt') ?? new Date();
    const closesAt = this.parseScheduledInstant(input.closesAt, 'closesAt');
    this.assertClosesAfterPublish(publishedAt, closesAt);
    // The opening post's photos and the thread's poll, resolved here with
    // everything else that can REJECT the request, so a blank option label, a
    // duplicated option or a poll closing before its thread is even published
    // costs no insert. Same posture as the community, the co-author handle and
    // the two dates above.
    assertSinglePhotoSpelling(input.image, input.photos);
    const photos = normalizePostPhotos(input.photos);
    const resolvedPoll = this.resolvePoll(input.poll, publishedAt);
    const resolved: ResolvedThreadFields = {
      isOfficial,
      isAnonymous,
      crossPosted,
      coAuthorId,
      publishedAt,
      closesAt,
      // A thread sent to the editors or the council starts PENDING, which
      // keeps it out of every member-facing read until somebody approves it.
      // Everything else starts NULL: never submitted, and visible.
      reviewState: input.submitForReview ? REVIEW_STATE_PENDING : null,
      // Filled in immediately below, once the two fields it reads are set.
      fannedOutAt: null,
    };
    // THE ONE QUESTION THAT DECIDES WHETHER THE FAN-OUT HAPPENS NOW.
    //
    // A thread published straight away (the overwhelmingly common case) keeps
    // exactly the behaviour it has always had: the activity event, the topic
    // link and the mention notifications all fire in this request, and the row
    // is INSERTED already marked as fanned out, so nothing later can repeat it
    // and no extra statement is spent marking it.
    //
    // A thread created SCHEDULED or PENDING REVIEW defers all three. The link
    // in a mention notification 404s behind the read gate, so that half was
    // never the leak; the payload's `excerpt` carries the first 140 characters
    // of the body, and that reached other members before the thread was
    // visible and, in the review case, before a moderator had read it. Review
    // exists so a sensitive thread is read by a moderator FIRST, so fanning out
    // at create time defeated the feature outright.
    //
    // Deferring is not suppressing: `publishThread` runs the whole fan-out when
    // the thread actually becomes visible, so nothing is lost, only delayed to
    // the instant it was always meant to happen.
    const isVisibleOnCreate = isThreadPublished(resolved);
    resolved.fannedOutAt = isVisibleOnCreate ? new Date() : null;
    const { thread, opPost } = await this.createWithUniqueSlug(
      authorId,
      input,
      communityId,
      resolved,
      resolvedPoll,
      photos,
    );
    // SOC-13 — the author follows their own thread from the moment it exists,
    // so the replies to a question they asked reach them without a second
    // deliberate act. Best-effort: the thread has already committed. NOT part
    // of the deferred fan-out: subscribing the author to their own thread
    // discloses the thread to nobody, and an author whose scheduled thread
    // collects a reply the minute it opens should hear about it.
    await this.subscriptions.subscribeQuietly(thread.id, authorId);
    if (isVisibleOnCreate) {
      await this.runThreadFanOut(thread, input.body);
    }
    const [byline, polls, photoRows] = await Promise.all([
      this.bylineRefs(thread),
      // Read back rather than rebuilt from `resolvedPoll`/`photos`: the echo
      // then carries the ids the client needs to vote and the ordering the
      // database actually stored, instead of a hand-assembled copy that could
      // drift from the rows behind it. Both are no-ops (one short query, or
      // none at all) for the overwhelmingly common thread with neither.
      resolvedPoll
        ? pollViewsByThread(
            this.threads.manager,
            [thread.id],
            authorId,
            viewerIsModerator,
          )
        : Promise.resolve(new Map<string, ForumPollView>()),
      photos.length
        ? photoRowsByPost(this.threads.manager, [opPost.id])
        : Promise.resolve(new Map<string, ForumPostPhoto[]>()),
    ]);
    // The author has just created the OP and cannot have voted on it yet, so
    // `myVote` is 0 by construction — no vote lookup needed for this echo. The
    // fresh OP is live (not tombstoned/edited), so its card flags follow from
    // authorship + the viewer's own moderator role.
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: authorId, isModerator: viewerIsModerator },
      opPost,
      0,
      // The author was just auto-subscribed above, so the echo can say so
      // without a read-back.
      true,
      // Nothing has moderated a post created a moment ago, and there is no
      // watermark to count against yet — both explicit only because
      // `coAuthor` sits behind them.
      undefined,
      null,
      byline.coAuthor,
      photoRows.get(opPost.id) ?? [],
      polls.get(thread.id) ?? null,
    );
  }

  /**
   * THE DEFERRED FAN-OUT, RUN EXACTLY ONCE, FOR ONE THREAD.
   *
   * A thread created scheduled or pending review is inserted with
   * `fanned_out_at` NULL, meaning "this thread still owes the forum its
   * announcement". This is the only thing that pays that debt, and the only
   * thing that may: `create` runs `runThreadFanOut` directly and only for a
   * thread that was already visible on insert, where the insert itself is the
   * claim.
   *
   * ## Why it is safe under concurrent requests
   *
   * The claim is ONE conditional statement:
   *
   *     UPDATE forum_thread SET fanned_out_at = now()
   *      WHERE id = $1 AND fanned_out_at IS NULL
   *
   * and the fan-out runs only for the caller whose statement reports ONE
   * affected row. Two requests that observe the same thread becoming visible in
   * the same millisecond both issue it; Postgres takes a row lock, so the
   * second one blocks, and when it proceeds under READ COMMITTED it
   * re-evaluates its `WHERE` against the value the first one COMMITTED. The
   * predicate no longer holds, it matches zero rows, and that caller returns
   * without fanning out. There is no window between "check" and "write" for a
   * second request to slip through, because there is no separate check: the
   * predicate and the write are the same statement. Nothing here needs an
   * advisory lock, a transaction, or a second table.
   *
   * The early `fannedOutAt !== null` return above the claim is a cheap
   * short-circuit for the common case, NOT the correctness guarantee — it reads
   * an in-memory field that may be stale by the time it is read, which is
   * exactly why the database re-asks the same question atomically.
   *
   * The guarantee is therefore AT MOST ONCE, deliberately. The three side
   * effects behind it are all best-effort by construction (the event bus is
   * fire-and-forget, `linkThread` never throws, `mentions.notify` swallows its
   * own failures), so claiming before fanning out cannot lose an answer anybody
   * is waiting on, while claiming after would let a crash between the two send
   * the same mention twice.
   *
   * ## Why there is no cron
   *
   * There is none in this module, and a scheduled thread does not need one:
   * `magazine_article.publishedAt` set the precedent that THE READ GATE IS THE
   * SCHEDULER. A future `published_at` hides the thread from every member-facing
   * path on its own, so "it is time" is a fact any request can observe. This is
   * called from `loadOr404`/`loadByIdOr404` — every by-slug and by-id read AND
   * every write that goes through them — and from `reviewThread` when a
   * moderator approves. The first of those to see a visible thread that still
   * owes its fan-out pays the debt, once, for everybody.
   *
   * Returns whether THIS call is the one that fanned out, which is what the
   * specs assert on.
   */
  async publishThread(threadId: string): Promise<boolean> {
    const thread = await this.threads.findOne({ where: { id: threadId } });
    if (!thread) return false;
    return this.publishLoadedThread(thread);
  }

  /**
   * `publishThread` for a caller that already holds the row, so the common case
   * (a thread that fanned out long ago) costs no query at all.
   */
  private async publishLoadedThread(thread: ForumThread): Promise<boolean> {
    // Already paid. Cheap, in-memory, and the reason this can sit on the hot
    // read path: every thread on the forum but a handful answers here.
    if (thread.fannedOutAt !== null) return false;
    // A withdrawn thread announces nothing. Without this, a moderator opening a
    // scheduled thread its author had already withdrawn (staff reads pass
    // `includeDeleted`) would fan out a thread nobody can read.
    if (thread.deletedAt !== null) return false;
    // Not yet: still scheduled ahead, or still pending, or rejected. The debt
    // stays owed and the next observer asks again.
    if (!isThreadPublished(thread)) return false;

    const claim = await this.threads
      .createQueryBuilder()
      .update(ForumThread)
      .set({ fannedOutAt: () => 'now()' })
      .where('id = :id AND fanned_out_at IS NULL', { id: thread.id })
      .execute();
    if (claim.affected !== 1) return false;
    // Keep the in-memory row honest for whatever the caller does next with it
    // (an echo, a second gate check). The exact instant is the database's; this
    // only has to be non-null.
    thread.fannedOutAt = new Date();

    // The body lives on the opening post, not on the thread, so the deferred
    // fan-out has to read it back — `create` had it in hand and this does not.
    // A tombstoned OP yields no body, which quietly turns the mention fan-out
    // off: an author who withdrew their own opening post before the thread went
    // live has unsaid what the excerpt would have quoted.
    const opPost = await this.posts.findOne({
      where: { threadId: thread.id, isOp: true },
    });
    const body = opPost && !opPost.deletedAt ? opPost.body : '';
    // Wrapped, unlike `create`'s inline call, because this one sits on the READ
    // path: a listener that throws must never turn somebody opening a thread
    // into a 500. The claim has already committed, so a failure here loses the
    // announcement rather than repeating it, which is the at-most-once trade
    // this method's docstring makes deliberately.
    try {
      await this.runThreadFanOut(thread, body);
    } catch (error) {
      this.logger.warn(
        `Deferred fan-out failed for forum thread ${thread.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    return true;
  }

  /**
   * The three announcements a newly visible thread makes, in one place so the
   * create path and the deferred path cannot drift.
   *
   * All three are best-effort and none may throw back at the caller: by the
   * time this runs the thread has committed, and a failed notification must
   * never look like a failed post.
   */
  private async runThreadFanOut(
    thread: ForumThread,
    body: string,
  ): Promise<void> {
    // Public profile activity for the author. Fire-and-forget on the event bus
    // — a listener failure must never affect thread creation (see profiles
    // `ActivityListener`).
    this.eventEmitter.emit(FORUM_THREAD_CREATED, {
      authorId: thread.authorId,
      threadSlug: thread.slug,
      title: thread.title,
    } satisfies ForumThreadCreatedEvent);
    // DISC-5 — best-effort, never throws (see `TopicPostLinkService.linkThread`);
    // a matching tag materializes a `topic_post` row and fans out DISC-3's
    // topic-follow notification (`TOPIC_POST_LINKED`, topics module).
    await this.topicPostLink.linkThread(thread, body);
    // No body, nothing to have mentioned anybody in. Guarded rather than left
    // to `extractMentions` returning nothing, so the intent is on the page.
    if (!body) return;
    await this.mentions.notify(body, thread.authorId, {
      actorId: thread.authorId,
      source: 'forum',
      threadSlug: thread.slug,
      excerpt: body.slice(0, 140),
    });
  }

  /**
   * A thread may not close before it opens.
   *
   * IN THE SERVICE, NOT ON THE DTO, and the reason is the same one
   * `parseScheduledInstant` gives for the future/one-year window living here.
   * The comparison itself is clock-free and a class-validator cross-field rule
   * could express it — but only for the half of the cases where BOTH fields
   * arrived. An omitted `publishAt` means "now", which is a value the DTO
   * cannot see and the service has already resolved by the time it gets here,
   * so a DTO rule would answer one shape of the question and silently pass the
   * other. One check, on two parsed `Date`s, after both defaults have been
   * applied, answers all of it. `EventsService.assertScheduleValid` is the
   * precedent, including the shape of the message.
   *
   * Equality is rejected along with inversion: a thread that closes at the
   * instant it opens is closed on arrival, which is the state this exists to
   * prevent rather than an edge of it.
   */
  private assertClosesAfterPublish(
    publishedAt: Date,
    closesAt: Date | null,
  ): void {
    if (!closesAt) return;
    if (closesAt.getTime() <= publishedAt.getTime()) {
      throw new BadRequestException(
        'closesAt must be after the thread is published',
      );
    }
  }

  /**
   * GET /admin/forum/review — the moderator queue of threads waiting on a
   * decision, newest first.
   *
   * Pages through `cursorPaginate`'s default `(createdAt, id)` keyset, which is
   * why `AddForumThreadPublishLifecycle1817310000000` builds
   * `IDX_forum_thread_review_pending_created_at_id` partial on exactly
   * `review_state = 'pending'` and descending on exactly those two columns.
   *
   * NEWEST FIRST rather than oldest first, which is worth saying because a
   * review queue is the kind of thing that usually reads oldest first. This one
   * is not an SLA queue: there is no promised turnaround on a thread its author
   * chose to hold back, nothing expires, and the console's own
   * `oldestWaitingAt` already surfaces the backlog's age. Matching the forum's
   * own `new` sort keeps one mental model of "the thread list, filtered".
   *
   * WITHDRAWN THREADS ARE EXCLUDED. An author who submits a thread for review
   * and then deletes it has answered the question themselves, and a moderator
   * cannot usefully approve a thread that no longer exists.
   *
   * The mapper runs with `viewerIsModerator: true` because only moderators
   * reach this route, which is also what lets it render threads no member-facing
   * read path would return.
   */
  async listPendingReview(
    user: CurrentUserData,
    cursor: string | undefined,
    limit: number | undefined,
  ): Promise<CursorPage<ForumThreadResponse>> {
    const qb = this.threads
      .createQueryBuilder('t')
      .where('t.review_state = :pendingReview', {
        pendingReview: REVIEW_STATE_PENDING,
      })
      .andWhere('t.deleted_at IS NULL');
    const page = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      't',
      true,
    );
    return {
      data: await this.toThreadResponses(page.rows, user.userId, true),
      pageInfo: { nextCursor: page.nextCursor, hasMore: page.hasMore },
    };
  }

  /**
   * POST /admin/forum/threads/:slug/review — a moderator's verdict on a thread
   * its author held back (`CreateThreadDto.submitForReview`).
   *
   * APPROVING hands the thread straight to the step-1 publish path, so the
   * fan-out it has been owing since it was created goes out now: the author's
   * profile activity, the topics link and its follow notifications, and the
   * @mentions in the opening post, with the excerpt finally reaching other
   * members at the moment a moderator has actually read it. If the author ALSO
   * scheduled the thread for later, `publishLoadedThread` declines (the thread
   * is approved but not yet visible) and the debt stays owed until its instant
   * arrives, which is the correct reading of two independent gates.
   *
   * REJECTING leaves the thread invisible to everyone but its author and staff.
   * Nothing is deleted: `review_state = 'rejected'` fails the read gate exactly
   * as `pending` does, the author keeps their own thread and the reviewer's
   * note, and a rejection is therefore reversible by a human rather than by a
   * restore.
   *
   * ONE DECISION PER THREAD. Anything that is not still `pending` is a 409, so
   * two moderators opening the queue together cannot both decide, an approval
   * cannot be walked back into a rejection through this route, and the author's
   * notification cannot be written twice.
   */
  async reviewThread(
    slug: string,
    user: CurrentUserData,
    approve: boolean,
    note?: string,
  ): Promise<ForumThreadResponse> {
    // The route's own guard already refuses anyone else; repeated here for the
    // same reason `setLocked` repeats it, so the service cannot be reached
    // through a future caller that forgets the decorator.
    if (!isModeratorRole(user.role)) {
      throw new ForbiddenException('Only a moderator can review threads');
    }
    const thread = await this.loadOr404(slug, undefined, {
      // A pending thread is by definition not visible, so the review path has
      // to reach past the gate it is deciding. A WITHDRAWN one is not
      // reachable: its author has already answered the question.
      includeUnpublished: true,
    });
    if (thread.reviewState !== REVIEW_STATE_PENDING) {
      throw new ConflictException('This thread is not waiting on a review');
    }
    thread.reviewState = approve
      ? REVIEW_STATE_APPROVED
      : REVIEW_STATE_REJECTED;
    await this.threads.save(thread);
    await this.auditThreadAction(
      user,
      approve
        ? THREAD_AUDIT_ACTIONS.reviewApproved
        : THREAD_AUDIT_ACTIONS.reviewRejected,
      thread,
      note,
    );
    if (approve) {
      // The deferred fan-out, finally. No-ops when the author also scheduled
      // the thread ahead, and idempotent regardless.
      await this.publishLoadedThread(thread);
    }
    await this.notifyAuthorOfReview(thread, approve, note);
    const [byline, op] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator: true },
      op.opPost,
      op.myVote,
      // Same as every other staff echo on this service: nothing here resolves
      // the reviewer's own subscription or a read watermark, and null is "no
      // unread information", never "nothing new".
      false,
      op.moderation,
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
    );
  }

  /**
   * Tells the author what was decided. Best-effort: the verdict has already
   * committed, and a notification that fails must not turn a completed review
   * into a 500 a moderator would then retry into a 409.
   *
   * NO ACTOR, so the bell reads as the platform speaking and no block or mute
   * between the author and the reviewing moderator can swallow it. The payload
   * carries the author's own thread title and the reviewer's optional note, and
   * nothing of the thread's body: it is the author's own text and they are
   * holding it.
   */
  private async notifyAuthorOfReview(
    thread: ForumThread,
    approve: boolean,
    note?: string,
  ): Promise<void> {
    try {
      await this.notifications.create(
        thread.authorId,
        NotificationType.ForumThreadReviewed,
        {
          source: 'forum',
          threadSlug: thread.slug,
          title: thread.title,
          decision: approve ? 'approved' : 'rejected',
          ...(note ? { reviewNote: note } : {}),
        },
      );
    } catch (error) {
      this.logger.warn(
        `Failed to notify ${thread.authorId} of the review verdict on forum thread ${thread.slug}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /**
   * Shared with `ForumPostsService` — 404s a thread lookup by slug.
   *
   * When `viewerId` is supplied, a thread whose author is blocked in either
   * direction is also 404 — the same "don't leak existence" shape
   * `CommunityPostsService.assertViewable` uses for private communities, so a
   * blocked author's thread can't be reached by guessing its slug either.
   *
   * Also gates community access: a thread scoped to a community on any tier
   * but `public` 404s for a viewer who isn't on that community's roster (again
   * mirroring `CommunityPostsService.assertViewable`), so a gated community's
   * threads and their posts can't be read by a non-member who guesses or holds
   * the slug. Because `ForumPostsService.reply`/read paths load through here
   * with the viewer's id, this closes the thread-detail AND post-list leak in
   * one place. Threads with a null `communityId` (flat/global) belong to no
   * roster and stay reachable by everyone, as do threads in a `public`
   * community. Privileged callers
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
   *
   * And 404s a thread that is scheduled for later or waiting on a review
   * (`isThreadPublished`) — for everybody EXCEPT its own author, who needs no
   * flag, and staff, who pass `includeUnpublished`. This is the single-row half
   * of the read gate the browse paths carry as `FORUM_THREAD_VISIBLE_SQL`, and
   * `applyPublishedThreadGate` explains why the author's bypass is applied here
   * rather than as an OR arm on the browse query.
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
    // The read gate IS the scheduler: this request has just observed whether
    // the thread is visible, so it is also the cheapest honest moment to pay
    // any fan-out the thread still owes. Costs nothing but an in-memory null
    // check for every thread that has already fanned out, which is all of them
    // but the handful that were scheduled or held for review.
    await this.publishLoadedThread(thread);
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
   * and gated-community rules. Both entry points share
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
    // Same deferred-fan-out hook as `loadOr404`; see it for why this sits on
    // the read path.
    await this.publishLoadedThread(thread);
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
    // The scheduled/under-review gate, as a row check rather than a SQL arm.
    // This is where the AUTHOR's bypass lives, and why it lives here: a single
    // read has no ORDER BY and so no keyset to lose, while the same bypass
    // expressed as an `OR author_id = :viewerId` arm on the browse query would
    // cost every viewer both partial-index seeks (see
    // `applyPublishedThreadGate`). Staff pass `includeUnpublished`.
    if (
      !options?.includeUnpublished &&
      thread.authorId !== viewerId &&
      !isThreadPublished(thread)
    ) {
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
   * Shared with `ForumPostsService.reply`: a thread scoped to a community
   * takes replies from that community's ROSTER only.
   *
   * `create` has always required membership (`assertMemberBySlug`), and
   * `loadOr404`'s access gate keeps a GATED community's threads out of a
   * non-member's reach entirely: every tier but `public` closes its content to
   * anyone off the roster, so the only thread a non-member can read at all is
   * one in a `public` community. This closes the remaining half (BE-COM-05):
   * on the `public` tier the thread is readable by any signed-in member, but
   * writing into it is a roster action, exactly as it is for the community's
   * own post feed (`CommunityPostsService.assertMember` on every write, while
   * its `assertViewable` lets a non-member READ a `public` community's board
   * and nothing more).
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
    // Filing a thread is janitorial and a moderator may do it at any time, so
    // the scheduled/under-review gate must not put a pending guide out of their
    // reach (see `applyPublishedThreadGate` for where each bypass lives).
    const thread = await this.loadOr404(slug, user.userId, {
      includeUnpublished: isModeratorRole(user.role),
    });
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

    const byline = await this.bylineRefs(thread);
    // `opPost` (oldest post) is the OP; reuse it rather than a second lookup.
    const myVote = opPost
      ? ((
          await this.votes.findOne({
            where: { postId: opPost.id, userId: user.userId },
          })
        )?.value ?? 0)
      : 0;
    // A title/tag/category edit touches neither the poll nor the photos, but
    // the echo is what the client renders NEXT, so leaving them out would have
    // an edit blank the gallery and drop the ballot from the page until a
    // reload put them back. Resolved through the same two batched helpers every
    // other read uses, with a one-element id list.
    const [pollByThread, photosByPost] = await Promise.all([
      pollViewsByThread(
        this.threads.manager,
        [thread.id],
        user.userId,
        isModerator,
      ),
      photoRowsByPost(this.threads.manager, opPost ? [opPost.id] : []),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator },
      opPost,
      myVote,
      await this.subscriptions.isSubscribed(thread.id, user.userId),
      undefined,
      null,
      byline.coAuthor,
      opPost ? (photosByPost.get(opPost.id) ?? []) : [],
      pollByThread.get(thread.id) ?? null,
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
      // A thread can be withdrawn before it ever publishes — by its author,
      // whom the gate lets through anyway, and by a moderator, who needs this.
      includeUnpublished: true,
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

    const [byline, op, isSubscribed] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
      this.subscriptions.isSubscribed(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
    const thread = await this.loadOr404(slug, user.userId, {
      includeUnpublished: isModeratorRole(user.role),
    });
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

    const [byline, op, isSubscribed] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
      this.subscriptions.isSubscribed(thread.id, user.userId),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
    const thread = await this.loadOr404(slug, user.userId, {
      includeUnpublished: isModeratorRole(user.role),
    });
    if (isSubscribed) {
      await this.subscriptions.subscribe(thread.id, user.userId);
    } else {
      await this.subscriptions.unsubscribe(thread.id, user.userId);
    }

    const [byline, op] = await Promise.all([
      this.bylineRefs(thread),
      this.resolveOp(thread.id, user.userId, isModeratorRole(user.role)),
    ]);
    return toForumThreadResponse(
      thread,
      byline.author,
      { userId: user.userId, isModerator: isModeratorRole(user.role) },
      op.opPost,
      op.myVote,
      isSubscribed,
      op.moderation,
      null,
      byline.coAuthor,
      op.opPhotos,
      op.poll,
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
    // A query builder rather than `find()`, so this lane runs the SAME two
    // gates every other read path does through the same two helpers. The
    // review disjunction is not expressible as a `find()` `where` without
    // either an OR'd condition array (which would multiply the other
    // predicates) or a second spelling of the gate, and a second spelling is
    // the one thing `FORUM_THREAD_VISIBLE_SQL` exists to prevent.
    const qb = this.threads
      .createQueryBuilder('t')
      .where('t.community_id = :communityId', { communityId });
    // Withdrawn threads stay out of the community pulse too (PRD-160); this
    // lane has no viewer and so no staff view to preserve, which is also why
    // both helpers are passed `false`.
    this.excludeDeletedThreads(qb, false);
    this.applyPublishedThreadGate(qb, false);
    const rows = await qb
      .orderBy('t.created_at', 'DESC')
      .addOrderBy('t.id', 'DESC')
      .take(limit)
      .getMany();
    if (!rows.length) return [];
    return this.toThreadResponses(rows, '', false);
  }

  // --- internals ---

  /**
   * Resolves `coAuthorHandle` to a user id, or null when no co-author was
   * named.
   *
   * A HANDLE THAT RESOLVES TO NOBODY IS A 400, not a silently dropped field.
   * The whole point of the credit is that a guide two people wrote carries both
   * names, so publishing it with one name and no warning is the one outcome the
   * author would not have chosen. `MemberLookup.userIdsForSlugs` only matches
   * ACTIVE members, so a suspended or deleted account reads as "no such member"
   * here, which is the honest answer at the moment of writing.
   *
   * The CALLER'S OWN handle is a 400 too: `author_id` already credits them, and
   * a self-co-author would render the same name twice on the card and count
   * them twice in anything that later reads the pair.
   */
  /**
   * Validates and normalizes the optional poll before the create transaction
   * opens: the labels are trimmed and proven distinct
   * (`resolvePollLabels`), and `closesAt` is parsed and held to the SAME
   * window `publishAt`/`closesAt` are held to — strictly in the future and at
   * most a year out, through the one `parseScheduledInstant` the thread's own
   * dates use, so a poll cannot be scheduled by rules the thread is not.
   *
   * A poll that closes before its thread is even published is a 400 rather
   * than a poll nobody can ever answer, reusing `assertClosesAfterPublish`.
   * Its message names `closesAt`, which is the right word here too: the field
   * is `poll.closesAt` and it is the value the author needs to change.
   */
  private resolvePoll(
    poll: CreateThreadPollDto | undefined,
    publishedAt: Date,
  ): ResolvedPollInput | null {
    if (!poll) return null;
    const closesAt = this.parseScheduledInstant(poll.closesAt, 'poll.closesAt');
    this.assertClosesAfterPublish(publishedAt, closesAt);
    return {
      labels: resolvePollLabels(poll),
      allowMultiple: !!poll.allowMultiple,
      closesAt,
    };
  }

  private async resolveCoAuthorId(
    handle: string | undefined,
    authorId: string,
  ): Promise<string | null> {
    const normalized = handle?.trim();
    if (!normalized) return null;
    const coAuthorId = await new MemberLookup(this.profiles).userIdForSlug(
      normalized,
    );
    if (!coAuthorId) {
      throw new BadRequestException(
        'No member with that handle to credit as co-author',
      );
    }
    if (coAuthorId === authorId) {
      throw new BadRequestException(
        'You are already credited on this thread, so you cannot be its co-author',
      );
    }
    return coAuthorId;
  }

  /**
   * Parses a `publishAt`/`closesAt` ISO-8601 string and holds it to the one
   * window both share: strictly in the future, at most `MAX_SCHEDULE_AHEAD_MS`
   * out. Returns null when the field was omitted.
   *
   * The window lives here rather than on the DTO because a class-validator
   * decorator is evaluated against a clock it cannot see at decoration time;
   * `EventsService.assertScheduleValid` is the precedent and this follows it,
   * including the shape of the messages. The DTO still owns the FORMAT
   * (`@IsISO8601()`), so the `Number.isNaN` branch below only fires for a
   * caller that reached the service another way.
   */
  private parseScheduledInstant(
    value: string | undefined,
    field: string,
  ): Date | null {
    if (value === undefined) return null;
    const at = new Date(value);
    if (Number.isNaN(at.getTime())) {
      throw new BadRequestException(`${field} must be an ISO-8601 timestamp`);
    }
    const now = Date.now();
    if (at.getTime() <= now) {
      throw new BadRequestException(`${field} must be in the future`);
    }
    if (at.getTime() - now > MAX_SCHEDULE_AHEAD_MS) {
      throw new BadRequestException(`${field} must be at most a year from now`);
    }
    return at;
  }

  /**
   * The thread's byline, both halves, in ONE profile query.
   *
   * Every single-thread echo used to resolve `[thread.authorId]` inline. A
   * co-author would have turned each of those into either a second lookup or a
   * second inline id list to keep in step, so they all go through here instead:
   * one `MemberLookup` call, one place where a byline is assembled, and no echo
   * that can quietly forget the co-author. The batched page mapper
   * (`toThreadResponses`) does the same job across a whole page.
   */
  private async bylineRefs(
    thread: ForumThread,
  ): Promise<{ author: MemberRef | null; coAuthor: MemberRef | null }> {
    const ids = thread.coAuthorId
      ? [thread.authorId, thread.coAuthorId]
      : [thread.authorId];
    const refs = await new MemberLookup(this.profiles).byUserIds(ids);
    return {
      author: refs.get(thread.authorId) ?? null,
      coAuthor: thread.coAuthorId
        ? (refs.get(thread.coAuthorId) ?? null)
        : null,
    };
  }

  private async createWithUniqueSlug(
    authorId: string,
    input: CreateThreadInput,
    communityId: string | null,
    resolved: ResolvedThreadFields,
    // Both already validated and normalized by `create` (see `resolvePoll` and
    // `normalizePostPhotos`), so nothing in here has to decide what is
    // trustworthy — it only writes.
    resolvedPoll: ResolvedPollInput | null,
    photos: PostPhotoInput[],
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
              isOfficial: resolved.isOfficial,
              tags: normalizeTags(input.tags),
              communityId,
              // The composer's ten fields. The four that pass straight through
              // are normalized here (or explicitly NULLed) rather than left to
              // a column default, because a create that names every column is
              // what makes the insert readable next to the entity.
              kind: input.kind ?? null,
              contentWarnings: normalizeContentWarnings(input.contentWarnings),
              neighbourhood: input.neighbourhood?.trim() || null,
              language: input.language ?? null,
              // The seven `create` already decided (coerced flags, a resolved
              // co-author id, parsed dates, the review state, the fan-out mark)
              // — see `ResolvedThreadFields`.
              isAnonymous: resolved.isAnonymous,
              coAuthorId: resolved.coAuthorId,
              publishedAt: resolved.publishedAt,
              reviewState: resolved.reviewState,
              // The create fan-out mark. A visible thread is inserted already
              // marked, which is what makes the INSERT its own claim: no other
              // request can race for a row that does not exist yet. A scheduled
              // or pending thread is inserted NULL, owing its announcement.
              fannedOutAt: resolved.fannedOutAt,
              crossPosted: resolved.crossPosted,
              closesAt: resolved.closesAt,
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

          // INSIDE the same transaction as the thread and its OP, which is the
          // whole point: a thread that committed while its poll's options did
          // not would render as a question with nothing to pick, and the
          // `UNIQUE (thread_id)` on `forum_poll` means a retry could not simply
          // add them afterwards. The photos ride along for the same reason —
          // an OP that commits without the gallery its author attached is a
          // post they have to edit to repair.
          if (resolvedPoll) {
            await insertThreadPoll(manager, thread.id, resolvedPoll);
          }
          await insertPostPhotos(manager, opPost.id, photos);

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

  /**
   * Takes threads scheduled for later, and threads waiting on a review, out of
   * a browse/count/search query. The predicate itself is
   * `FORUM_THREAD_VISIBLE_SQL`; read its docstring for why its text is frozen.
   *
   * A BRANCH, NOT AN `OR author_id = :viewerId` ARM — this is the load-bearing
   * choice here, so it is worth spelling out.
   *
   * Both hot sorts (`top`, `unanswered`) seek through partial indexes whose
   * predicates carry the review disjunction. A query predicate only matches a
   * partial index if it IMPLIES that index's predicate, and
   * `(gate OR author_id = :viewer)` implies nothing: the moment the arm is
   * added, the planner's best remaining option is a BitmapOr of the partial
   * index and `IDX_forum_thread_author_id`, and a bitmap scan returns rows
   * unordered — which is the keyset seek gone, for EVERY viewer, to serve the
   * handful who happen to have a scheduled thread. The common case here is a
   * non-moderator browsing the list, and it stays on the index by carrying the
   * gate as a plain conjunct.
   *
   * So the two bypasses are applied where each costs nothing. A MODERATOR skips
   * the predicate entirely (this branch, mirroring `excludeDeletedThreads`
   * exactly). An AUTHOR's own rows are let through by `assertVisibleOr404`, the
   * single-row gate behind `loadOr404`/`loadByIdOr404`, where there is no
   * ORDER BY and therefore no seek to lose: their scheduled thread is reachable
   * by its link, by every write path they own, and by the echo each of those
   * returns. What it is not is a row in the browse list, which is the correct
   * reading anyway — a thread scheduled for Friday is, by its author's own
   * instruction, not part of what the forum is showing today.
   */
  private applyPublishedThreadGate(
    qb: SelectQueryBuilder<ForumThread>,
    viewerIsModerator: boolean,
  ): void {
    if (viewerIsModerator) return;
    // ONE `andWhere`, one frozen string: split across two calls, the arms stop
    // matching the partial index predicate.
    qb.andWhere(FORUM_THREAD_VISIBLE_SQL);
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
  // The two boxes also apply the SAME community gate now: this one is narrowed
  // by `applyCommunityAccessFilter` below, and `searchByText` builds the same
  // "the community is `public`, OR the viewer is on its roster" predicate over
  // reply bodies. Neither box can surface a thread the other hides, in either
  // direction: being "as good as the header" is about finding answers, never
  // about admitting a community that refused the viewer.
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
  // community access tier: a thread scoped to a community stays in the result
  // set only when that community is `public`, or when the viewer is on its
  // roster. Every other tier (`request`, `invite`, `private`) closes its
  // content to anyone off that roster, which is what the community gate
  // promises: the same set `CommunityPostsService.assertViewable` admits for a
  // community's own board, and the same set the `community_post` feed branch
  // admits. Threads with a null `community_id` (flat/global) belong to no
  // roster, so no gate applies to them and they stay visible to everyone.
  //
  // The tier test asks "is `public`" rather than "is not one of the closed
  // tiers", for the reason `isGatedTier` (`src/communities/community-gate.ts`)
  // is written the same way: a tier added later stays closed until somebody
  // deliberately opens it.
  //
  // Expressed as correlated EXISTS subqueries (not a join) so it stacks
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
            AND "com"."access_tier" = :publicTier
        )
        OR EXISTS (
          SELECT 1 FROM "community_members" "mem"
          WHERE "mem"."community_id" = t.community_id
            AND "mem"."user_id" = :viewerId
        )
      )`,
      { publicTier: AccessTier.Public, viewerId },
    );
  }

  // Single-thread counterpart to `applyCommunityAccessFilter`, used by
  // `loadOr404`: true only when the thread's community is NOT `public` AND the
  // viewer isn't on its roster, the exact condition
  // `CommunityPostsService.assertViewable` refuses on. Every tier but `public`
  // closes its content to anyone off the roster, which is what the community
  // gate promises, so a `request`- or `invite`-tier thread now hides from a
  // non-member exactly as a `private` one always did. Flat/global threads never
  // reach here: `loadOr404` only probes when the thread carries a
  // `communityId`, so no gate applies to them.
  //
  // This one reads the tier half inverted, so it asks for the gated tiers
  // instead of for `public`. The list comes from `GATED_ACCESS_TIERS`
  // (derived from `isGatedTier`) rather than being spelled out here, so a tier
  // added later hides its content until somebody deliberately opens it.
  //
  // Runs against the `communities` entity via the thread repo's shared entity
  // manager, so `ForumModule` needs no extra `Community` repository
  // registration.
  private async isCommunityHiddenFrom(
    communityId: string,
    viewerId: string,
  ): Promise<boolean> {
    return this.threads.manager
      .createQueryBuilder(Community, 'com')
      .where('com.id = :communityId', { communityId })
      .andWhere('com.accessTier IN (:...gatedTiers)', {
        gatedTiers: GATED_ACCESS_TIERS,
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

  // Resolves a single thread's OP post, the viewer's vote on it, the OP's
  // moderation state, the OP's photos and the thread's poll, for the
  // single-thread echoes (getBySlug/lock/delete) that don't run through the
  // batched `toThreadResponses`. A handful of point lookups run in parallel;
  // `null`/0/visible/empty when the OP is missing. The caller derives
  // `opPostId`, the OP card flags, `excerpt`, `opPhotos` and `poll` from what
  // comes back.
  //
  // The poll is resolved through `pollViewsByThread` with a ONE-ELEMENT id
  // list rather than a second, single-row query of its own. That costs
  // identically (every `IN` degenerates to an equality on one id) and buys the
  // thing that matters: the page mapper and every single-thread echo build a
  // poll view through exactly one function, so the results-visibility rule
  // cannot hold on the list and leak on the detail page.
  private async resolveOp(
    threadId: string,
    viewerId: string,
    viewerIsModerator: boolean,
  ): Promise<{
    opPost: ForumPost | null;
    myVote: number;
    moderation: ContentModerationState;
    opPhotos: ForumPostPhoto[];
    poll: ForumPollView | null;
  }> {
    const [op, polls] = await Promise.all([
      this.posts.findOne({ where: { threadId, isOp: true } }),
      pollViewsByThread(
        this.threads.manager,
        [threadId],
        viewerId,
        viewerIsModerator,
      ),
    ]);
    const poll = polls.get(threadId) ?? null;
    if (!op) {
      return {
        opPost: null,
        myVote: 0,
        moderation: OP_NOT_MODERATED,
        opPhotos: [],
        poll,
      };
    }
    const [vote, moderationStates, photosByPost] = await Promise.all([
      this.votes.findOne({ where: { postId: op.id, userId: viewerId } }),
      // PRD-167 — the card now quotes the OP body, so it has to know whether a
      // moderator took that body down before it does.
      this.contentModeration.statesForAnyType(OP_MODERATION_SUBJECT_TYPES, [
        op.id,
      ]),
      photoRowsByPost(this.threads.manager, [op.id]),
    ]);
    return {
      opPost: op,
      myVote: vote?.value ?? 0,
      moderation: moderationStates.get(op.id) ?? OP_NOT_MODERATED,
      opPhotos: photosByPost.get(op.id) ?? [],
      poll,
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
    // Authors AND co-authors in one id set, so a page of co-written guides
    // still costs the one profile query a page of ordinary threads does. This
    // is the batched counterpart of `bylineRefs`.
    const authorIds = [
      ...new Set(
        rows.flatMap((t) =>
          t.coAuthorId ? [t.authorId, t.coAuthorId] : [t.authorId],
        ),
      ),
    ];
    const threadIds = rows.map((t) => t.id);

    const [
      authors,
      opPosts,
      subscribedThreadIds,
      unreadByThread,
      pollByThread,
    ] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.posts.find({ where: { isOp: true, threadId: In(threadIds) } }),
      // One `user_id = :viewer AND thread_id IN (...)` query for the whole
      // page, never a per-row existence probe.
      this.subscriptions.subscribedThreadIds(threadIds, viewerId),
      // Same rule for the unread badge (C7/PRD-170): one grouped count across
      // the page, not one per row.
      this.unreadReplyCountsByThread(threadIds, viewerId),
      // And for the polls: THREE queries for the whole page (the polls, their
      // options, the viewer's own ballots), never three per thread. See
      // `pollViewsByThread`, which the single-thread echoes call too so the
      // results-visibility rule has one implementation.
      pollViewsByThread(
        this.threads.manager,
        threadIds,
        viewerId,
        viewerIsModerator,
      ),
    ]);
    const opByThread = new Map(opPosts.map((post) => [post.threadId, post]));

    const opIds = opPosts.map((post) => post.id);
    // Both keyed on the SAME id list, so they go out together rather than one
    // after the other. `opModerationStates` is what keeps a hidden or removed
    // OP's words out of the page's excerpts (PRD-167).
    const [myVoteRows, opModerationStates, photosByPost] = opIds.length
      ? await Promise.all([
          this.votes.find({ where: { postId: In(opIds), userId: viewerId } }),
          this.contentModeration.statesForAnyType(
            OP_MODERATION_SUBJECT_TYPES,
            opIds,
          ),
          // One `post_id IN (...)` query for every OP on the page, ordered by
          // `position` in SQL — never one gallery read per thread.
          photoRowsByPost(this.threads.manager, opIds),
        ])
      : [
          [],
          new Map<string, ContentModerationState>(),
          new Map<string, ForumPostPhoto[]>(),
        ];
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
        // Resolved out of the same batch as the author above; null both when
        // the thread has no co-author and when that member has no profile.
        t.coAuthorId ? (authors.get(t.coAuthorId) ?? null) : null,
        op ? (photosByPost.get(op.id) ?? []) : [],
        // Absent from the map = this thread carries no poll, which is nearly
        // every thread.
        pollByThread.get(t.id) ?? null,
      );
    });
  }
}
