import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, ObjectLiteral, Repository, SelectQueryBuilder } from 'typeorm';
import {
  CursorPage,
  cursorPaginate,
  decodeCursor,
  encodeCursor,
} from '../common/cursor-pagination';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import {
  AccessTier,
  Community,
} from '../communities/entities/community.entity';
import { ConnectionsService } from '../connections/connections.service';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { FeedTab } from './dto/get-feed.query';
import {
  AffinityFacts,
  FeedReason,
  interleaveByAffinity,
  isEmptyGraph,
  matchedTopicSlug,
  scoreAffinity,
  ViewerGraph,
} from './feed-affinity';
import {
  EMPTY_POST_INTERACTIONS,
  FeedInteractionsService,
  FeedPostInteractions,
} from './feed-interactions.service';
import {
  MutedFeedSources,
  NO_MUTED_SOURCES,
  FeedMuteService,
} from './feed-mute.service';
import { decodeRankedCursor, encodeRankedCursor } from './feed-ranked-cursor';
import {
  communityNewMemberToFeedItem,
  communityPostToFeedItem,
  eventToFeedItem,
  FeedItem,
  FeedItemSignals,
  FeedItemSource,
  forumThreadToFeedItem,
  newMemberToFeedItem,
} from './feed-response';

const DEFAULT_LIMIT = 20;

/**
 * How many pages' worth of chronological candidates the "All" tab ranks at
 * once (SOC-04). Three keeps the extra read small (61 rows per source instead
 * of 21) while giving the affinity lane enough depth to actually reorder
 * something. See `feed-ranked-cursor.ts` for why ranking needs a window at
 * all.
 */
const RANK_WINDOW_PAGES = 3;

/** The underlying stores this read-time aggregation unions. `new_member`
 * (recently-joined active members, for the "People" tab) reads `profiles`
 * directly rather than a dedicated feed table — same "no new table" idiom the
 * other sources follow. `community_new_member` (Task 5) is the same idea
 * scoped to communities the viewer belongs to ("X joined {community}"); it
 * reads `community_members` directly and is unioned into the `communities`
 * tab alongside the other three sources, each additionally membership-scoped
 * there (Task 6 — see `sourcesForTab` and the `membershipScoped` branches in
 * `fetchCandidates`). Its candidates map to a FINAL `FeedItem.type` of
 * `'new_member'` too (see `communityNewMemberToFeedItem`'s docstring) —
 * `'community_new_member'` only exists as this internal discriminator. */
type SourceKind =
  | 'community_post'
  | 'forum_thread'
  | 'gathering'
  | 'new_member'
  | 'community_new_member';

/**
 * A row from any one source, reduced to just what the cross-source merge
 * needs (identity, ordering key, the author to block-filter/resolve by) plus
 * the original row so `toFeedItems` can map it once merging/filtering is
 * done.
 */
interface Candidate {
  id: string;
  createdAt: Date;
  type: SourceKind;
  // Null for a `community_post` whose author's account was erased — the
  // post itself is preserved (tombstoned), so it still surfaces here; there's
  // just no author to block-check or resolve a byline for.
  authorId: string | null;
  row: CommunityPost | ForumThread | Event | Profile | CommunityMember;
}

/** Same ordering `cursorPaginate` applies per-source: newest first, `id`
 * descending as a deterministic tie-break (matters once rows from different
 * sources can share a millisecond). */
function compareCandidatesDesc(a: Candidate, b: Candidate): number {
  const diff = b.createdAt.getTime() - a.createdAt.getTime();
  if (diff !== 0) return diff;
  if (a.id === b.id) return 0;
  return a.id < b.id ? 1 : -1;
}

/** A candidate's identity ACROSS sources. Ids alone aren't enough: a
 *  `new_member` candidate is keyed by the member's user id and a
 *  `community_new_member` by a membership id, so the source discriminator has
 *  to be part of the key for the ranked interleave to dedupe correctly. */
function candidateKey(candidate: Candidate): string {
  return `${candidate.type}:${candidate.id}`;
}

/** The community a candidate belongs to, or null. Used both to collect the
 *  batched community lookup and to score membership affinity. */
function communityIdOf(candidate: Candidate): string | null {
  switch (candidate.type) {
    case 'community_post':
      return (candidate.row as CommunityPost).communityId;
    case 'forum_thread':
      return (candidate.row as ForumThread).communityId;
    case 'gathering':
      return (candidate.row as Event).communityId;
    case 'community_new_member':
      return (candidate.row as CommunityMember).communityId;
    case 'new_member':
      return null;
  }
}

/** Every distinct community id a candidate list references, for one batched
 *  `IN` lookup instead of a per-candidate one. */
function collectCommunityIds(candidates: Candidate[]): string[] {
  return [
    ...new Set(
      candidates
        .map(communityIdOf)
        .filter((communityId): communityId is string => communityId !== null),
    ),
  ];
}

/**
 * The three facts `scoreAffinity` is allowed to look at, read off a
 * candidate. `tags` is whatever the item's own subject publishes: a
 * community's curated tags for a post scoped to it, a thread's freeform tags,
 * a new member's public profile tags. A gathering has no tags column, so it
 * can only ever score on membership or connection.
 */
function affinityFactsOf(
  candidate: Candidate,
  communityById: Map<string, Community>,
): AffinityFacts {
  const communityId = communityIdOf(candidate);
  const community = communityId
    ? (communityById.get(communityId) ?? null)
    : null;
  let tags: string[] = [];
  if (candidate.type === 'forum_thread') {
    tags = (candidate.row as ForumThread).tags ?? [];
  } else if (candidate.type === 'new_member') {
    tags = (candidate.row as Profile).tags ?? [];
  } else if (candidate.type === 'community_post') {
    tags = community?.tags ?? [];
  }
  return { communityId, authorId: candidate.authorId, tags };
}

/**
 * `GET /feed?tab=&cursor=` — read-time aggregation over `community_posts`,
 * `forum_thread`, `events` (the "gathering" the frontend's `FeedItem` union
 * calls it), and `profiles` (recently-joined active members, "new_member" —
 * backs the "People" tab). No new table: every page is assembled by querying
 * each included source, merging, and re-paginating in memory.
 *
 * CURSOR / MERGE STRATEGY: for a page of size `limit`, we ask each included
 * source for its own top `limit + 1` rows after the cursor (via
 * `cursorPaginate`, which already knows how to decode/apply the
 * `(createdAt, id) < cursor` keyset predicate — `CommunityPost`,
 * `ForumThread`, and `Event` all satisfy its `{ id: string; createdAt: Date }`
 * constraint; `Profile`'s PK is `userId` rather than `id`, so its
 * `new_member` case builds the same `(createdAt, id) < cursor` predicate by
 * hand instead of going through `cursorPaginate`). This is enough to
 * guarantee correctness: the true global top-`(limit + 1)` rows across all
 * sources, restricted to any single source, can't rank worse than
 * `limit + 1` *within that source* — so if we fetch each source's own top
 * `limit + 1`, the merged set is guaranteed to contain the true global top
 * `limit + 1`. Sorting the merged candidates and taking the first
 * `limit + 1` therefore gives an exact answer, not an approximation.
 *
 * The cursor/`hasMore` for the *next* request is anchored to this raw,
 * pre-block-filter boundary (the `limit`-th candidate) — block/mute filtering
 * happens strictly after that boundary is fixed, so a page can come back
 * with fewer than `limit` items when some of its authors are blocked or
 * muted, but the next page's cursor never skips a row: it always continues
 * exactly where this page's underlying merge left off.
 */
@Injectable()
export class FeedService {
  constructor(
    @InjectRepository(CommunityPost)
    private readonly communityPosts: Repository<CommunityPost>,
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(ForumThread)
    private readonly forumThreads: Repository<ForumThread>,
    @InjectRepository(Event)
    private readonly events: Repository<Event>,
    @InjectRepository(Profile)
    private readonly profiles: Repository<Profile>,
    @InjectRepository(CommunityMember)
    private readonly communityMembers: Repository<CommunityMember>,
    @InjectRepository(TopicFollow)
    private readonly topicFollows: Repository<TopicFollow>,
    private readonly blockFilter: BlockFilterService,
    private readonly connectionsService: ConnectionsService,
    private readonly feedInteractions: FeedInteractionsService,
    private readonly feedMutes: FeedMuteService,
  ) {}

  /**
   * Takedown subject codes, matching what each domain's OWN read path already
   * filters on so the feed can never disagree with the surface it links to:
   * `event` (`EventsService.SUBJECT_TYPE`), and `post`/`reply` for community
   * posts and forum OPs (`CommunityPostsService.SUBJECT_TYPES` /
   * `ForumPostsService.SUBJECT_TYPES` — a forum thread is reported through its
   * OP *post*, keyed by that post's uuid, which is why the thread predicate
   * below goes through `forum_post` rather than the thread id).
   */
  private static readonly EVENT_SUBJECT_TYPES = ['event'];
  private static readonly POST_SUBJECT_TYPES = ['post', 'reply'];

  /**
   * Drops rows whose subject carries a moderator takedown — hidden OR removed.
   *
   * BOTH states are excluded, unlike `ContentModerationService.excludeHidden`
   * (which keeps removed rows so a thread can render them as `[removed]`): the
   * aggregated feed has no tombstone rendering, so a removed item would surface
   * with its real title, summary and deep link. Same shape and same reasoning as
   * `EventsService.excludeModeratedEvents`, applied in-query so a fixed-size
   * candidate page isn't under-filled and the merge boundary stays exact.
   *
   * `subjectIdColumn` is spliced verbatim into raw SQL — pass a literal alias
   * reference, never user input. It is cast to `text` because
   * `content_moderation.subject_id` is `varchar` while every candidate id is a
   * `uuid`. Call at most once per query builder (fixed bound-parameter name).
   */
  private excludeModerated<E extends ObjectLiteral>(
    qb: SelectQueryBuilder<E>,
    subjectTypes: readonly string[],
    subjectIdColumn: string,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "content_moderation" "feed_cm"
        WHERE "feed_cm"."subject_type" IN (:...feedModerationSubjectTypes)
          AND "feed_cm"."subject_id" = ${subjectIdColumn}::text
          AND ("feed_cm"."hidden_at" IS NOT NULL OR "feed_cm"."removed_at" IS NOT NULL)
      )`,
      { feedModerationSubjectTypes: [...subjectTypes] },
    );
  }

  /**
   * The forum variant of {@link excludeModerated}: a thread has no
   * `content_moderation` row of its own — moderators take down its OPENING
   * POST (`forum_post.is_op`), which is what the client reports and what
   * `ForumPostsService` reads. A thread whose OP is hidden or removed is
   * therefore dropped from the feed, where only its title and category would
   * have shown anyway (with a deep link straight into the withheld body).
   */
  private excludeModeratedForumThreads(
    qb: SelectQueryBuilder<ForumThread>,
  ): void {
    qb.andWhere(
      `NOT EXISTS (
        SELECT 1 FROM "forum_post" "feed_op"
        JOIN "content_moderation" "feed_cm"
          ON "feed_cm"."subject_type" IN (:...feedModerationSubjectTypes)
         AND "feed_cm"."subject_id" = "feed_op"."id"::text
        WHERE "feed_op"."thread_id" = t.id
          AND "feed_op"."is_op" = true
          AND ("feed_cm"."hidden_at" IS NOT NULL OR "feed_cm"."removed_at" IS NOT NULL)
      )`,
      { feedModerationSubjectTypes: [...FeedService.POST_SUBJECT_TYPES] },
    );
  }

  async getFeed(
    viewerId: string,
    tab: FeedTab | undefined,
    cursor: string | undefined,
    limit: number = DEFAULT_LIMIT,
  ): Promise<CursorPage<FeedItem>> {
    const resolvedTab = tab ?? 'all';
    // SOC-18: "show me less of this" applies to every tab, including the
    // scoped ones — a member who turned a community down should not meet it
    // again by tapping Communities. One small indexed read per request.
    const mutedSources = await this.feedMutes.mutedSources(viewerId);
    if (resolvedTab === 'all') {
      return this.getRankedAllFeed(viewerId, cursor, limit, mutedSources);
    }
    const sources = this.sourcesForTab(resolvedTab);
    // Personalizes the community_post/gathering/forum_thread source cases to
    // the viewer's own memberships when serving the `communities` tab (Task
    // 6) — see the per-case `if (membershipScoped)` branches below.
    // `community_new_member` needs no branch: it's already inherently
    // viewer-scoped (Task 5).
    const membershipScoped = resolvedTab === 'communities';
    // DISC-2: personalizes the same three author-bearing sources to the
    // viewer's ACCEPTED connections when serving the `connections` tab —
    // orthogonal to `membershipScoped` (never both true at once, since each
    // is tied to its own tab). `null` means "not scoped this way" (every
    // other tab); resolved once per request rather than per source, since
    // all three branches below filter against the exact same id set.
    const connectionAuthorIds =
      resolvedTab === 'connections'
        ? await this.connectionsService.allAcceptedConnectionUserIds(viewerId)
        : null;

    const perSourceLimit = limit + 1;
    const candidateLists = await Promise.all(
      sources.map((source) =>
        this.fetchCandidates(
          source,
          viewerId,
          cursor,
          perSourceLimit,
          membershipScoped,
          connectionAuthorIds,
          mutedSources,
        ),
      ),
    );
    const merged = candidateLists.flat().sort(compareCandidatesDesc);

    const globalPage = merged.slice(0, limit + 1);
    const hasMore = globalPage.length > limit;
    const pageCandidates = hasMore ? globalPage.slice(0, limit) : globalPage;
    const lastCandidate = pageCandidates[pageCandidates.length - 1];
    const nextCursor =
      hasMore && lastCandidate ? encodeCursor(lastCandidate) : null;

    const visible = await this.dropBlocked(viewerId, pageCandidates);
    const data = await this.toFeedItems(visible, viewerId);

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  /**
   * The "All" tab (SOC-04). Same union of sources and the same visibility
   * rules as before; what changes is the ORDER, and only for a member who has
   * actually joined, connected or followed something.
   *
   * A chronological WINDOW of `limit * RANK_WINDOW_PAGES` candidates is
   * fetched, ranked, and served one page at a time out of that window. The
   * cursor carries the window's chronological boundary plus how far into its
   * ranked order we already are — see `feed-ranked-cursor.ts` for why ranking
   * cannot reuse a plain keyset cursor, and why re-ranking the same window on
   * the next request is guaranteed to reproduce the same order.
   *
   * A member with no memberships, no accepted connections and no followed
   * topics skips ranking entirely (`isEmptyGraph`): they get the identical
   * reverse-chronological feed that existed before this, at the old cost.
   */
  private async getRankedAllFeed(
    viewerId: string,
    cursor: string | undefined,
    limit: number,
    mutedSources: MutedFeedSources,
  ): Promise<CursorPage<FeedItem>> {
    const { windowCursor, offset } = decodeRankedCursor(cursor);
    const graph = await this.viewerGraph(viewerId);
    const windowSize = limit * RANK_WINDOW_PAGES;

    const candidateLists = await Promise.all(
      this.sourcesForTab('all').map((source) =>
        this.fetchCandidates(
          source,
          viewerId,
          windowCursor,
          windowSize + 1,
          false,
          null,
          mutedSources,
        ),
      ),
    );
    const merged = candidateLists.flat().sort(compareCandidatesDesc);

    const windowSlice = merged.slice(0, windowSize + 1);
    const hasMoreBeyondWindow = windowSlice.length > windowSize;
    const windowCandidates = hasMoreBeyondWindow
      ? windowSlice.slice(0, windowSize)
      : windowSlice;
    const windowBoundary = windowCandidates[windowCandidates.length - 1];

    // Community rows for the whole window: a post's followed-topic match is
    // made against its COMMUNITY's tags, so they have to be resolved before
    // ranking rather than during the final mapping. The map is handed on to
    // `toFeedItems` so the page costs one `IN` query, not two.
    const communityById = await this.communitiesByIds(
      collectCommunityIds(windowCandidates),
    );

    const scoreByCandidate = new Map<string, number>();
    const reasonByCandidate = new Map<string, FeedReason>();
    const topicByCandidate = new Map<string, string | null>();
    for (const candidate of windowCandidates) {
      const facts = affinityFactsOf(candidate, communityById);
      const { score, reason } = scoreAffinity(facts, graph);
      const key = candidateKey(candidate);
      scoreByCandidate.set(key, score);
      reasonByCandidate.set(key, reason);
      topicByCandidate.set(key, matchedTopicSlug(facts.tags, graph));
    }

    const ranked = isEmptyGraph(graph)
      ? windowCandidates
      : interleaveByAffinity(
          windowCandidates,
          (candidate) => scoreByCandidate.get(candidateKey(candidate)) ?? 0,
          compareCandidatesDesc,
        );

    const pageCandidates = ranked.slice(offset, offset + limit);
    const nextOffset = offset + limit;
    let nextCursor: string | null = null;
    if (nextOffset < ranked.length) {
      // Still inside this window: advance the offset, keep the window.
      nextCursor = encodeRankedCursor(windowCursor, nextOffset);
    } else if (hasMoreBeyondWindow && windowBoundary) {
      // Window exhausted: seek past its chronological boundary and start a
      // fresh ranked window from offset zero.
      nextCursor = encodeRankedCursor(encodeCursor(windowBoundary), 0);
    }
    const hasMore = nextCursor !== null;

    const visible = await this.dropBlocked(viewerId, pageCandidates);
    const data = await this.toFeedItems(visible, viewerId, {
      communityById,
      reasonByCandidate,
      topicByCandidate,
    });

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  /**
   * The three explicit graph facts the "All" tab ranks on (SOC-04), resolved
   * once per request. Every one of them is something the member did on
   * purpose and can undo: leave the community, remove the connection, unfollow
   * the topic. Nothing here is derived from what they looked at.
   */
  private async viewerGraph(viewerId: string): Promise<ViewerGraph> {
    const [memberships, connectionUserIds, follows] = await Promise.all([
      this.communityMembers.find({ where: { userId: viewerId } }),
      this.connectionsService.allAcceptedConnectionUserIds(viewerId),
      this.topicFollows.find({ where: { userId: viewerId } }),
    ]);
    return {
      communityIds: new Set(
        memberships.map((membership) => membership.communityId),
      ),
      connectionUserIds: new Set(connectionUserIds),
      followedTopicSlugs: new Set(follows.map((follow) => follow.topicSlug)),
    };
  }

  // --- internals ---

  /** `tab` -> which sources are unioned. `people` unions just `new_member`;
   * `all` includes it alongside the other three, so recently-joined members
   * surface in the unfiltered feed too. `communities` unions all four
   * membership-scoped sources (Task 6) — note it uses
   * `community_new_member`, NOT the global `new_member` that `all`/`people`
   * use, since this tab is personalized to the viewer's own communities.
   * `connections` (DISC-2) unions the three author-bearing sources —
   * `community_post`, `forum_thread`, `gathering` — each additionally
   * author-scoped to the viewer's accepted connections in `fetchCandidates`
   * (the `connectionAuthorIds` branches below). It deliberately excludes
   * `new_member`/`community_new_member`: those sources surface a PROFILE as
   * the candidate itself (the newly-joined member), not something a member
   * AUTHORED, so "from your connections" doesn't apply to them. */
  private sourcesForTab(tab: FeedTab): SourceKind[] {
    switch (tab) {
      case 'communities':
        return [
          'community_post',
          'gathering',
          'forum_thread',
          'community_new_member',
        ];
      case 'connections':
        return ['community_post', 'forum_thread', 'gathering'];
      case 'gatherings':
        return ['gathering'];
      case 'posts':
        return ['community_post', 'forum_thread'];
      case 'people':
        return ['new_member'];
      case 'all':
      default:
        return ['community_post', 'forum_thread', 'gathering', 'new_member'];
    }
  }

  private async fetchCandidates(
    kind: SourceKind,
    viewerId: string,
    cursor: string | undefined,
    limit: number,
    membershipScoped: boolean,
    // DISC-2: non-null on the `connections` tab only. An empty array means
    // the viewer has zero accepted connections — short-circuit to no
    // candidates rather than issuing an `IN ()` query (invalid SQL, and a
    // wasted round-trip either way).
    connectionAuthorIds: string[] | null = null,
    // SOC-18: the sources this viewer asked their feed to show less of.
    // Applied here, alongside the block filter's spiritual sibling, so a
    // muted room never even reaches the merge: filtering it out afterwards
    // would under-fill the page and let the mute cost the member content
    // from everywhere else.
    mutedSources: MutedFeedSources = NO_MUTED_SOURCES,
  ): Promise<Candidate[]> {
    if (connectionAuthorIds !== null && connectionAuthorIds.length === 0) {
      return [];
    }
    const { communityIds: mutedCommunityIds, forumThreadIds: mutedThreadIds } =
      mutedSources;
    switch (kind) {
      case 'community_post': {
        // Soft-deleted posts are tombstoned in-place in a community's own feed
        // (they render as "[deleted]"), but the aggregated feed has no
        // tombstone rendering — so surfacing one would leak its original
        // `body`. Redact it from the feed entirely.
        //
        // Access-tier / membership gate (mirrors the gathering branch's "don't
        // leak non-public content into a general feed" intent): a post scoped
        // to a community only surfaces when that community isn't `private`, OR
        // the viewer is a member of it — otherwise a private, invite-only
        // community's post bodies and deep links would leak to non-members via
        // the feed. A flat/global post (`community_id IS NULL`, see
        // `CommunityPost.communityId`) is scoped to no community's roster and
        // stays visible to everyone.
        //
        // Expressed as correlated EXISTS subqueries rather than an innerJoin
        // for the same reason the `new_member` branch below is join-free:
        // `cursorPaginate` runs `.take() + getMany()` with a raw
        // `date_trunc(...)` ORDER BY, and TypeORM's `.take()`+join "distinct
        // pagination" path can't emit that raw expression correctly.
        const qb = this.communityPosts
          .createQueryBuilder('cp')
          .where('cp.deletedAt IS NULL');
        // A moderator takedown outranks every visibility rule below it: a
        // hidden/removed post must not reach the feed, which has no tombstone
        // rendering and would surface its real title, 220-char body excerpt
        // and deep link.
        this.excludeModerated(qb, FeedService.POST_SUBJECT_TYPES, '"cp"."id"');
        if (membershipScoped) {
          // `communities` tab (Task 6): drop the access-tier gate entirely
          // and restrict to communities the viewer belongs to — this also
          // drops flat/global posts (`community_id IS NULL`), which have no
          // community roster to be a member of.
          qb.andWhere(
            `cp.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = cp.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        } else {
          qb.andWhere(
            `(
              cp.community_id IS NULL
              OR EXISTS (
                SELECT 1 FROM "communities" "com"
                WHERE "com"."id" = cp.community_id
                  AND "com"."access_tier" != :privateTier
              )
              OR EXISTS (
                SELECT 1 FROM "community_members" "mem"
                WHERE "mem"."community_id" = cp.community_id
                  AND "mem"."user_id" = :viewerId
              )
            )`,
            { privateTier: AccessTier.Private, viewerId },
          );
        }
        if (mutedCommunityIds.length) {
          // A muted community is silenced whole: its posts, and (below) its
          // threads, its gatherings and its new-member rows. A flat/global
          // post has no community to mute, so `IS NULL` keeps it.
          qb.andWhere(
            '(cp.community_id IS NULL OR cp.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): on top of whichever visibility gate
          // above applied, restrict to posts authored by one of the
          // viewer's accepted connections. Stacked, not swapped-in — a
          // connection's post in a private community the viewer hasn't
          // joined must still stay hidden.
          qb.andWhere('cp.author_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `CommunityPost.createdAt` is migrated to `timestamptz(3)`
        // (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so
        // `cursorPaginate` orders/filters on the raw column instead of
        // wrapping it in a non-indexable `date_trunc(...)` — served by
        // `IDX_community_posts_created_at_id`
        // (`1785001500000-AddFeedCursorIndexes.ts`).
        const { rows } = await cursorPaginate(qb, cursor, limit, 'cp', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'community_post' as const,
          authorId: row.authorId,
          row,
        }));
      }
      case 'forum_thread': {
        const qb = this.forumThreads.createQueryBuilder('t');
        // Takedown of the thread's OP — see `excludeModeratedForumThreads`.
        this.excludeModeratedForumThreads(qb);
        if (membershipScoped) {
          // `communities` tab (Task 6): restrict to threads posted in
          // communities the viewer belongs to.
          qb.andWhere(
            `t.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = t.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        } else {
          // Access-tier / membership gate, mirroring the `community_post`
          // branch above (and `ForumThreadsService`'s read paths): a thread
          // scoped to a Private community only surfaces when the viewer is on
          // its roster — otherwise a private community's thread titles and deep
          // links would leak to non-members via the general feed. A
          // flat/global thread (`community_id IS NULL`) and threads in
          // non-Private communities stay visible to everyone.
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
        if (mutedThreadIds.length) {
          // Per-thread mute: the one conversation, wherever it lives.
          qb.andWhere('t.id NOT IN (:...mutedThreadIds)', { mutedThreadIds });
        }
        if (mutedCommunityIds.length) {
          qb.andWhere(
            '(t.community_id IS NULL OR t.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): see the matching branch in
          // `community_post` above — same stacked-not-swapped rationale.
          qb.andWhere('t.author_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `ForumThread.createdAt` is migrated to `timestamptz(3)`
        // (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so the
        // keyset ORDER BY can use the existing `IDX_forum_thread_created_at_id`
        // (`1782800210000-AddForum.ts`) instead of the non-indexable
        // `date_trunc(...)` wrapper. The access-tier gate above narrows the
        // scan with correlated EXISTS subqueries rather than a join, keeping
        // the single-query keyset-pagination path (same reasoning as the
        // `community_post` branch).
        const { rows } = await cursorPaginate(qb, cursor, limit, 't', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'forum_thread' as const,
          authorId: row.authorId,
          row,
        }));
      }
      case 'gathering': {
        // Only surface events a general/unpersonalized feed reasonably can:
        // published (not draft/cancelled) and not invite-only (an
        // invite-only event's existence shouldn't leak to non-invitees via
        // the feed — that would need a per-viewer invite check this
        // aggregation doesn't do). The general feed's set is exactly
        // public/members — unchanged. The `communities` tab (membershipScoped
        // below) ALSO admits `community`-visibility gatherings: fix round 2
        // (Task B) — the membership EXISTS check right below already proves
        // the viewer is on that exact community's roster, so a `community`
        // -visibility event hosted under it is provably theirs to see; it was
        // simply never in the base visibility set for this case to widen.
        // `network`/`extended_network`/`invite_only` are deliberately NOT
        // added here — those aren't "provably visible because of THIS
        // community membership" the way `community` is; they need the real
        // per-event/per-viewer connection or invite check
        // (`EventAudienceGateService`), which this read-time aggregation
        // doesn't run (same reasoning invite_only was already excluded for).
        const visibilities = membershipScoped
          ? [
              EventVisibility.Public,
              EventVisibility.Members,
              EventVisibility.Community,
            ]
          : [EventVisibility.Public, EventVisibility.Members];
        const qb = this.events
          .createQueryBuilder('e')
          .where('e.status = :status', { status: EventStatus.Published })
          .andWhere('e.visibility IN (:...visibilities)', { visibilities });
        // Same takedown exclusion `EventsService.excludeModeratedEvents`
        // applies to browse + search, so a moderator-hidden gathering can no
        // longer be reached through the feed instead.
        this.excludeModerated(qb, FeedService.EVENT_SUBJECT_TYPES, '"e"."id"');
        if (membershipScoped) {
          // `communities` tab (Task 6): restrict to gatherings hosted by
          // communities the viewer belongs to.
          qb.andWhere(
            `e.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = e.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        }
        if (mutedCommunityIds.length) {
          qb.andWhere(
            '(e.community_id IS NULL OR e.community_id NOT IN (:...mutedCommunityIds))',
            { mutedCommunityIds },
          );
        }
        if (connectionAuthorIds !== null) {
          // `connections` tab (DISC-2): restrict to gatherings hosted by one
          // of the viewer's accepted connections. The base public/members
          // visibility set above still applies underneath — a connection
          // hosting a private/invite-only gathering doesn't leak it here.
          qb.andWhere('e.host_id IN (:...connectionAuthorIds)', {
            connectionAuthorIds,
          });
        }
        // `true`: `Event.createdAt` is migrated to `timestamptz(3)` (see
        // `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so the general
        // feed's `status`+`visibility` filter (public/members) can be served
        // by the partial index `IDX_events_feed_created_at_id`
        // (`1785001500000-AddFeedCursorIndexes.ts`), which was built to match
        // that exact predicate. The `membershipScoped` branch's WIDENED set
        // (adds `community`) no longer matches the index's own
        // `visibility IN ('public','members')` predicate — a query admitting
        // `community` rows is no longer a subset of what the index covers, so
        // Postgres can't use it for this branch (fix round 2, Task B: noted,
        // not fixed here — the `communities` tab is a much smaller
        // per-viewer slice than the open feed, and the query still has
        // `e.community_id IS NOT NULL AND EXISTS(...)` plus
        // `IDX_events_community_id` to fall back on; revisit only if a
        // measurement shows this tab is actually slow).
        const { rows } = await cursorPaginate(qb, cursor, limit, 'e', true);
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'gathering' as const,
          authorId: row.hostId,
          row,
        }));
      }
      case 'new_member': {
        // Recently-joined ACTIVE members, newest-first. Reads `profiles`
        // directly (no dedicated feed table, same idiom as the other three
        // sources). `Profile`'s PK is `userId` (not `id`), so it can't
        // satisfy `cursorPaginate`'s generic constraint — the same
        // `(createdAt, id) < cursor` keyset predicate is built by hand here
        // instead, mirroring `cursor-pagination.ts`'s millisecond-truncated
        // comparison so same-millisecond rows can't fall through the page
        // boundary. Excludes the viewer's own profile (mirrors
        // `ProfilesService#loadRelated`'s `p.user_id != :self`) — you
        // already know you joined, so you shouldn't see yourself as a "new
        // member" in your own feed.
        // NB: the active-user filter is a correlated EXISTS rather than an
        // innerJoin on purpose. TypeORM's `.take()` + join combination forces
        // getMany() down its two-query "distinct pagination" path, which can't
        // handle the raw `date_trunc(...)` ORDER BY below (it splits the
        // expression on '.' and treats a fragment as an alias name). Keeping
        // this join-free preserves the simple single-query path where the raw
        // ORDER BY is emitted verbatim.
        const qb = this.profiles
          .createQueryBuilder('p')
          .where('p.user_id != :viewerId', { viewerId })
          .andWhere(
            `EXISTS (SELECT 1 FROM "users" "u" WHERE "u"."id" = "p"."user_id" AND "u"."status" = :active)`,
            { active: UserStatus.Active },
          );

        const createdAtExpr = `date_trunc('milliseconds', "p"."created_at")`;
        qb.orderBy(createdAtExpr, 'DESC').addOrderBy('p.user_id', 'DESC');

        const decoded = cursor ? decodeCursor(cursor) : null;
        if (decoded) {
          qb.andWhere(
            `(${createdAtExpr}, p.user_id) < (:cursorCreatedAt, :cursorId)`,
            { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
          );
        }

        const rows = await qb.take(limit).getMany();
        return rows.map((row) => ({
          id: row.userId,
          createdAt: row.createdAt,
          type: 'new_member' as const,
          authorId: row.userId,
          row,
        }));
      }
      case 'community_new_member': {
        // Recently-joined ACTIVE members of communities the VIEWER also
        // belongs to, newest-first ("X joined {community}" — Task 5; not
        // unioned into any tab yet, see the `SourceKind` docstring).
        // `CommunityMember`'s PK IS `id` (unlike `Profile`'s `userId`-keyed
        // PK above), so this could in principle go through `cursorPaginate`
        // — but it's kept hand-rolled and join-free for the same reason the
        // `new_member` case above is: the membership+active-user filters
        // below are correlated EXISTS subqueries, and TypeORM's `.take()`
        // forces an innerJoin down the two-query "distinct pagination" path,
        // which can't emit the raw `date_trunc(...)` ORDER BY verbatim.
        //
        // `m.user_id != :viewerId` excludes the viewer's own membership rows
        // (mirrors `new_member`'s `p.user_id != :viewerId` — you already
        // know you joined). The first EXISTS restricts to memberships of
        // communities the viewer is ALSO a member of (a self-join on
        // `community_members` by `community_id`); the second is the same
        // active-user gate `new_member` applies.
        const qb = this.communityMembers
          .createQueryBuilder('m')
          .where('m.user_id != :viewerId', { viewerId })
          .andWhere(
            `EXISTS (
              SELECT 1 FROM "community_members" "self"
              WHERE "self"."community_id" = m.community_id
                AND "self"."user_id" = :viewerId
            )`,
            { viewerId },
          )
          .andWhere(
            `EXISTS (SELECT 1 FROM "users" "u" WHERE "u"."id" = "m"."user_id" AND "u"."status" = :active)`,
            { active: UserStatus.Active },
          );
        if (mutedCommunityIds.length) {
          qb.andWhere('m.community_id NOT IN (:...mutedCommunityIds)', {
            mutedCommunityIds,
          });
        }

        const joinedAtExpr = `date_trunc('milliseconds', "m"."joined_at")`;
        qb.orderBy(joinedAtExpr, 'DESC').addOrderBy('m.id', 'DESC');

        const decoded = cursor ? decodeCursor(cursor) : null;
        if (decoded) {
          qb.andWhere(
            `(${joinedAtExpr}, m.id) < (:cursorCreatedAt, :cursorId)`,
            { cursorCreatedAt: decoded.createdAt, cursorId: decoded.id },
          );
        }

        const rows = await qb.take(limit).getMany();
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.joinedAt,
          type: 'community_new_member' as const,
          authorId: row.userId,
          row,
        }));
      }
    }
  }

  /** Drops candidates whose author is blocked either way relative to the
   * viewer (spec §2), OR whom the viewer has muted (I10 —
   * `BlockFilterService.isMutedBy`'s docstring says a muted author's content
   * should be "hidden from feeds/lists"; unlike a block, a mute is
   * one-directional and never affects what the muted author themself sees).
   * Dedupes the author list first so a prolific author with several items on
   * the page is only checked once. */
  private async dropBlocked(
    viewerId: string,
    candidates: Candidate[],
  ): Promise<Candidate[]> {
    if (!candidates.length) return [];
    const authorIds = [
      ...new Set(
        candidates
          .map((c) => c.authorId)
          .filter((authorId): authorId is string => authorId !== null),
      ),
    ];
    const hiddenAuthorIds = await this.blockFilter.hiddenUserIds(
      viewerId,
      authorIds,
    );
    // A null `authorId` (erased author, tombstoned post) has no one to
    // block-check against, so it's never hidden on that basis.
    return candidates.filter(
      (c) => c.authorId === null || !hiddenAuthorIds.has(c.authorId),
    );
  }

  /** Batched community lookup shared by the ranking window and the final
   *  mapping, so a ranked page resolves its communities exactly once. */
  private async communitiesByIds(
    communityIds: string[],
  ): Promise<Map<string, Community>> {
    if (!communityIds.length) return new Map();
    const rows = await this.communities.find({
      where: { id: In(communityIds) },
    });
    return new Map(rows.map((community) => [community.id, community]));
  }

  /**
   * What ranking worked out about this page, threaded into the mapping so the
   * response can say WHY each item is here (SOC-04). Absent on every tab but
   * `all`, where the tab itself is the explanation.
   */
  private static readonly NO_RANKING: {
    communityById: Map<string, Community>;
    reasonByCandidate: Map<string, FeedReason>;
    topicByCandidate: Map<string, string | null>;
  } | null = null;

  /** Batched mapping for a page of merged candidates: one `IN`-query for
   * authors, one for communities and one pair for interaction counts across
   * the whole page, mirroring `ForumThreadsService.toThreadResponses`'s
   * batched-lookup idiom. */
  private async toFeedItems(
    candidates: Candidate[],
    viewerId: string,
    ranking: {
      communityById: Map<string, Community>;
      reasonByCandidate: Map<string, FeedReason>;
      topicByCandidate: Map<string, string | null>;
    } | null = FeedService.NO_RANKING,
  ): Promise<FeedItem[]> {
    if (!candidates.length) return [];

    const authorIds = [
      ...new Set(
        candidates
          .map((c) => c.authorId)
          .filter((authorId): authorId is string => authorId !== null),
      ),
    ];

    // Both `community_post` (nullable `communityId` — a flat/global post has
    // none) and `community_new_member` (always scoped to a community) need a
    // community row resolved, and a ranked page also needs the community
    // behind a thread or gathering to name its "you're in X" reason. Reuses
    // the ranking window's map when there is one, so the page never issues
    // the same `IN` query twice.
    // SOC-04: the interaction counts that let a `community_post` card react
    // and reply inline, two grouped queries for the whole page.
    const postIds = candidates
      .filter((c) => c.type === 'community_post')
      .map((c) => c.id);
    const [authors, communityById, interactionsByPostId] = await Promise.all([
      new MemberLookup(this.profiles).byUserIds(authorIds),
      ranking
        ? Promise.resolve(ranking.communityById)
        : this.communitiesByIds(collectCommunityIds(candidates)),
      this.feedInteractions.forPosts(postIds, viewerId),
    ]);

    /**
     * The source this card came from, so its menu can offer "show me less of
     * this" (SOC-18). A forum thread names ITSELF rather than the community
     * it sits in: the card is one conversation, and quieting the whole room
     * from it would be a bigger act than the member asked for. Everything
     * else names its community, and a flat/global item names nothing.
     */
    const sourceFor = (
      candidate: Candidate,
      community: Community | null,
    ): FeedItemSource | null => {
      if (candidate.type === 'forum_thread') {
        const thread = candidate.row as ForumThread;
        return { kind: 'forum_thread', id: thread.id, name: thread.title };
      }
      if (!community) return null;
      return { kind: 'community', id: community.id, name: community.name };
    };

    /** The reason line for one candidate, resolved to something a member can
     *  read: the community's name, the actor's name, or the topic slug they
     *  follow. Only present on a ranked ("All") page; `source` is present
     *  everywhere. */
    const signalsFor = (
      candidate: Candidate,
      author: MemberRef | null,
      community: Community | null,
    ): FeedItemSignals => {
      const source = sourceFor(candidate, community);
      if (!ranking) return { source };
      const key = candidateKey(candidate);
      const reason = ranking.reasonByCandidate.get(key) ?? 'recent';
      let reasonSubject: string | null = null;
      if (reason === 'membership') {
        reasonSubject = community?.name ?? null;
      } else if (reason === 'connection') {
        reasonSubject = author
          ? `${author.firstName} ${author.lastName}`.trim()
          : null;
      } else if (reason === 'topic') {
        reasonSubject = ranking.topicByCandidate.get(key) ?? null;
      }
      return { source, reason, reasonSubject };
    };

    /** Reaction/reply state for a `community_post`, defaulting to the empty
     *  seed for a post nobody has touched yet. */
    const interactionsFor = (postId: string): FeedPostInteractions =>
      interactionsByPostId.get(postId) ?? EMPTY_POST_INTERACTIONS;

    return candidates.map((c) => {
      const author: MemberRef | null = c.authorId
        ? (authors.get(c.authorId) ?? null)
        : null;
      const communityId = communityIdOf(c);
      const community = communityId
        ? (communityById.get(communityId) ?? null)
        : null;
      const signals = signalsFor(c, author, community);
      switch (c.type) {
        case 'community_post': {
          const post = c.row as CommunityPost;
          const { reactionCount, replyCount, myReaction } = interactionsFor(
            post.id,
          );
          return {
            ...communityPostToFeedItem(post, community, author),
            ...signals,
            reactionCount,
            replyCount,
            myReaction,
          };
        }
        case 'forum_thread':
          return {
            ...forumThreadToFeedItem(c.row as ForumThread, author),
            ...signals,
          };
        case 'gathering':
          return { ...eventToFeedItem(c.row as Event, author), ...signals };
        case 'new_member':
          return {
            ...newMemberToFeedItem(c.row as Profile, author),
            ...signals,
          };
        case 'community_new_member':
          return {
            ...communityNewMemberToFeedItem(
              c.id,
              c.createdAt,
              author,
              community,
            ),
            ...signals,
          };
      }
    });
  }
}
