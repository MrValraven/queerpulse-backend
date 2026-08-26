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
  toForumThreadResponse,
} from './forum-response';

const DEFAULT_LIMIT = 20;
const MAX_SLUG_ATTEMPTS = 5;
const MAX_TAGS = 5;
// Cap on simultaneously pinned threads — mirrors
// `ConversationsService.MAX_PINNED_CONVERSATIONS`, enforced the same way (an
// application-code count check in `setPinned`, not a DB constraint).
const MAX_PINNED_THREADS = 3;

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
} as const;

// A `GET /forum/threads` sort mode (mirrors `ListThreadsQuery.sort`). `new`
// (default) and `unanswered` both page the `(createdAt, id)` keyset; `top` and
// `active` swap the leading keyset column (see `keysetForSort`).
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
  ) {}

  // GET /forum/threads?category=&cursor=&sort=&tag=&q= — a cursor page ordered
  // by `sort` (default `new`), narrowed by category/tag/text.
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
    if (category) {
      qb.andWhere('t.category = :category', { category });
    }
    // Pinned threads live in their own bucket (`listPinned`, rendered above
    // this paginated list) — excluded here so a pinned thread never appears
    // twice across a scroll session.
    qb.andWhere('t.is_pinned = false');
    // `q`/`tag` fold in AFTER the block filter (spec §Backend): same visibility
    // rules first, then narrow the visible set by title text / tag membership.
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

    // `keyset` swaps the leading sort column for `top`/`active`; for
    // `new`/`unanswered` it's undefined, so `cursorPaginate` uses its default
    // `(createdAt, id)` keyset with the `true` millisecond-precision flag.
    // `ForumThread.createdAt` is migrated to `timestamptz(3)` (see
    // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so that default path
    // uses the existing `IDX_forum_thread_created_at_id` btree instead of a
    // full scan + in-memory sort; the `top`/`active` keysets are backed by
    // their own DESC composite indexes (`AddForumOpDenormalization`).
    const keyset = this.keysetForSort(sort);
    const { rows, nextCursor, hasMore } = await cursorPaginate(
      qb,
      cursor,
      limit ?? DEFAULT_LIMIT,
      't',
      true,
      keyset,
    );

    return {
      data: await this.toThreadResponses(rows, viewerId, viewerIsModerator),
      pageInfo: { nextCursor, hasMore },
    };
  }

  // GET /forum/threads/counts?q=&tag= — per-category visible-thread counts plus
  // an `all` total, honoring the same block filter + q/tag narrowing as
  // `list()`. One `GROUP BY category` query, never a per-category round-trip.
  async counts(
    viewerId: string,
    q: string | undefined,
    tag: string | undefined,
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
    });
    if (thread.isPinned !== pinned) {
      if (pinned) {
        const pinnedCount = await this.threads.count({
          where: { isPinned: true },
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
    const thread = await this.loadOr404(slug);
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
    });
    const [authors, op, isSubscribed] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds([thread.authorId]),
      this.resolveOp(thread.id, viewerId),
      this.subscriptions.isSubscribed(thread.id, viewerId),
    ]);
    return toForumThreadResponse(
      thread,
      authors.get(thread.authorId) ?? null,
      { userId: viewerId, isModerator: viewerIsModerator },
      op.opPost,
      op.myVote,
      isSubscribed,
    );
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
   */
  async loadOr404(
    slug: string,
    viewerId?: string,
    options?: { bypassCommunityAccess?: boolean },
  ): Promise<ForumThread> {
    const thread = await this.threads.findOne({ where: { slug } });
    if (!thread) {
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
    return thread;
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
   * PATCH /forum/threads/:slug — the thread's title and/or its tag set.
   *
   * TWO DIFFERENT PERMISSIONS, deliberately. The TITLE stays author-only: a
   * moderator rewriting the words someone chose is an editorial act the forum
   * has no appeal path for. TAGS are author-or-moderator: filing a thread under
   * the right topic is janitorial, it is what makes the archive findable, and
   * until SOC-13 the frontend never sent a tag edit at all even though the
   * backend already accepted one.
   *
   * Both fields are optional. Omitting `title` leaves it untouched (and writes
   * no edit revision); omitting `tags` leaves the tag set untouched, while an
   * explicit `[]` clears it.
   *
   * The title lives on the thread; edit-history is anchored to the OP post (the
   * `is_op` `ForumPost`), so a title change is snapshotted there with
   * `previousTitle` set.
   */
  async updateThread(
    slug: string,
    user: CurrentUserData,
    title?: string,
    tags?: string[],
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
    if (title === undefined && tags === undefined) {
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
    // A tags-only patch (the moderator/janitorial path) must not stamp an edit
    // revision on the OP: nothing about the post's words changed, and an
    // "edited" mark that appears because someone re-filed the thread would be
    // false on its face.
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
      where: { communityId },
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

  // Folds the text (`q` → title ILIKE) and tag (`:tag = ANY(t.tags)`) filters
  // onto a query builder. Shared by `list()` + `counts()` so both narrow the
  // visible set identically. Both filters are no-ops when their term is empty.
  private applyTextAndTagFilters(
    qb: SelectQueryBuilder<ForumThread>,
    q: string | undefined,
    tag: string | undefined,
  ): void {
    const term = q?.trim();
    if (term) {
      // `escapeLikeTerm` neutralizes `%`/`_` so they match literally.
      qb.andWhere('t.title ILIKE :q', { q: `%${escapeLikeTerm(term)}%` });
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

  // Maps a `sort` to its `cursorPaginate` keyset. `top`/`active` swap the
  // leading column (both DESC, `id` tie-break); `new`/`unanswered` return
  // undefined so the default `(createdAt, id)` keyset is used. Column exprs +
  // their backing DESC indexes are documented on the `ForumThread` entity.
  //
  // `op_vote_count`/`last_activity_at` are MUTABLE sort keys (a vote or a reply
  // changes a thread's position mid-scroll), so the keyset can skip or repeat a
  // thread across page boundaries as it moves. That trade-off is intentional and
  // accepted for infinite scroll — the alternative (a stable snapshot cursor) is
  // not worth the complexity here.
  private keysetForSort(
    sort: ThreadSort | undefined,
  ): CursorKeyset<ForumThread> | undefined {
    if (sort === 'top') {
      return {
        columnExpr: '"t"."op_vote_count"',
        direction: 'DESC',
        kind: 'number',
        getValue: (row) => row.opVoteCount,
      };
    }
    if (sort === 'active') {
      return {
        columnExpr: '"t"."last_activity_at"',
        direction: 'DESC',
        kind: 'date',
        getValue: (row) => row.lastActivityAt,
      };
    }
    return undefined;
  }

  // Resolves a single thread's OP post + the viewer's vote on it, for the
  // single-thread echoes (getBySlug/lock) that don't run through the batched
  // `toThreadResponses`. Two point lookups; `null`/0 when the OP is missing.
  // The caller derives `opPostId` and the OP card flags from the returned post.
  private async resolveOp(
    threadId: string,
    viewerId: string,
  ): Promise<{ opPost: ForumPost | null; myVote: number }> {
    const op = await this.posts.findOne({ where: { threadId, isOp: true } });
    if (!op) return { opPost: null, myVote: 0 };
    const vote = await this.votes.findOne({
      where: { postId: op.id, userId: viewerId },
    });
    return { opPost: op, myVote: vote?.value ?? 0 };
  }

  // Batched mapping for a page of threads. Three queries total regardless of
  // page size (no N+1): authors, the page's OP posts
  // (`WHERE is_op AND thread_id IN (...)`), and the viewer's votes on those OP
  // posts (`WHERE user_id = viewer AND post_id IN (opIds)`). `opPostId`/`myVote`
  // are threaded into each response; `opVoteCount`/`tags` ride on the row.
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

    const [authors, opPosts, subscribedThreadIds] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      this.posts.find({ where: { isOp: true, threadId: In(threadIds) } }),
      // One `user_id = :viewer AND thread_id IN (...)` query for the whole
      // page, never a per-row existence probe.
      this.subscriptions.subscribedThreadIds(threadIds, viewerId),
    ]);
    const opByThread = new Map(opPosts.map((post) => [post.threadId, post]));

    const opIds = opPosts.map((post) => post.id);
    const myVoteRows = opIds.length
      ? await this.votes.find({
          where: { postId: In(opIds), userId: viewerId },
        })
      : [];
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
      );
    });
  }
}
