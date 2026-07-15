import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
import {
  CursorPage,
  cursorPaginate,
  encodeCursor,
} from '../common/cursor-pagination';
import { MemberLookup, MemberRef } from '../common/member-ref';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { FeedTab } from './dto/get-feed.query';
import {
  communityPostToFeedItem,
  eventToFeedItem,
  FeedItem,
  forumThreadToFeedItem,
} from './feed-response';

const DEFAULT_LIMIT = 20;

/** The three underlying stores this read-time aggregation unions. */
type SourceKind = 'community_post' | 'forum_thread' | 'gathering';

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
  authorId: string;
  row: CommunityPost | ForumThread | Event;
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

/**
 * `GET /feed?tab=&cursor=` — read-time aggregation over `community_posts`,
 * `forum_thread`, and `events` (the "gathering" the frontend's `FeedItem`
 * union calls it). No new table: every page is assembled by querying each
 * included source, merging, and re-paginating in memory.
 *
 * CURSOR / MERGE STRATEGY: for a page of size `limit`, we ask each included
 * source for its own top `limit + 1` rows after the cursor (via
 * `cursorPaginate`, which already knows how to decode/apply the
 * `(createdAt, id) < cursor` keyset predicate — `CommunityPost`,
 * `ForumThread`, and `Event` all satisfy its `{ id: string; createdAt: Date }`
 * constraint). This is enough to guarantee correctness: the true global
 * top-`(limit + 1)` rows across all sources, restricted to any single
 * source, can't rank worse than `limit + 1` *within that source* — so if we
 * fetch each source's own top `limit + 1`, the merged set is guaranteed to
 * contain the true global top `limit + 1`. Sorting the merged candidates and
 * taking the first `limit + 1` therefore gives an exact answer, not an
 * approximation.
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
    private readonly blockFilter: BlockFilterService,
  ) {}

  async getFeed(
    viewerId: string,
    tab: FeedTab | undefined,
    cursor: string | undefined,
    limit: number = DEFAULT_LIMIT,
  ): Promise<CursorPage<FeedItem>> {
    const sources = this.sourcesForTab(tab ?? 'all');
    if (!sources.length) {
      // "people" — no FeedItem source represents a bare member (the union is
      // only community_post | forum_thread | gathering); see the module
      // report for why this returns an empty page rather than guessing at a
      // substitute source.
      return { data: [], pageInfo: { nextCursor: null, hasMore: false } };
    }

    const perSourceLimit = limit + 1;
    const candidateLists = await Promise.all(
      sources.map((source) =>
        this.fetchCandidates(source, cursor, perSourceLimit),
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
    const data = await this.toFeedItems(visible);

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  // --- internals ---

  /** `tab` -> which sources are unioned. See the module report for how
   * `people` (no FeedItem source) was handled. */
  private sourcesForTab(tab: FeedTab): SourceKind[] {
    switch (tab) {
      case 'communities':
        return ['community_post'];
      case 'gatherings':
        return ['gathering'];
      case 'posts':
        return ['community_post', 'forum_thread'];
      case 'people':
        return [];
      case 'all':
      default:
        return ['community_post', 'forum_thread', 'gathering'];
    }
  }

  private async fetchCandidates(
    kind: SourceKind,
    cursor: string | undefined,
    limit: number,
  ): Promise<Candidate[]> {
    switch (kind) {
      case 'community_post': {
        const qb = this.communityPosts.createQueryBuilder('cp');
        const { rows } = await cursorPaginate(qb, cursor, limit, 'cp');
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
        const { rows } = await cursorPaginate(qb, cursor, limit, 't');
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
        // aggregation doesn't do).
        const qb = this.events
          .createQueryBuilder('e')
          .where('e.status = :status', { status: EventStatus.Published })
          .andWhere('e.visibility IN (:...visibilities)', {
            visibilities: [EventVisibility.Public, EventVisibility.Members],
          });
        const { rows } = await cursorPaginate(qb, cursor, limit, 'e');
        return rows.map((row) => ({
          id: row.id,
          createdAt: row.createdAt,
          type: 'gathering' as const,
          authorId: row.hostId,
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
    const authorIds = [...new Set(candidates.map((c) => c.authorId))];
    const [blockedFlags, mutedFlags] = await Promise.all([
      Promise.all(
        authorIds.map((authorId) =>
          this.blockFilter.isBlockedEitherWay(viewerId, authorId),
        ),
      ),
      Promise.all(
        authorIds.map((authorId) =>
          this.blockFilter.isMutedBy(viewerId, authorId),
        ),
      ),
    ]);
    const hiddenAuthorIds = new Set(
      authorIds.filter((_, i) => blockedFlags[i] || mutedFlags[i]),
    );
    return candidates.filter((c) => !hiddenAuthorIds.has(c.authorId));
  }

  /** Batched mapping for a page of merged candidates: one `IN`-query for
   * authors and one for communities across the whole page, mirroring
   * `ForumThreadsService.toThreadResponses`'s batched-lookup idiom. */
  private async toFeedItems(candidates: Candidate[]): Promise<FeedItem[]> {
    if (!candidates.length) return [];

    const authorIds = [...new Set(candidates.map((c) => c.authorId))];
    const authors = await new MemberLookup(this.profiles).byUserIds(authorIds);

    const communityIds = [
      ...new Set(
        candidates
          .filter((c) => c.type === 'community_post')
          .map((c) => (c.row as CommunityPost).communityId)
          .filter((id): id is string => id !== null),
      ),
    ];
    const communityRows = communityIds.length
      ? await this.communities.find({ where: { id: In(communityIds) } })
      : [];
    const communityById = new Map(communityRows.map((c) => [c.id, c]));

    return candidates.map((c) => {
      const author: MemberRef | null = authors.get(c.authorId) ?? null;
      switch (c.type) {
        case 'community_post': {
          const post = c.row as CommunityPost;
          const community = post.communityId
            ? (communityById.get(post.communityId) ?? null)
            : null;
          return communityPostToFeedItem(post, community, author);
        }
        case 'forum_thread':
          return forumThreadToFeedItem(c.row as ForumThread, author);
        case 'gathering':
          return eventToFeedItem(c.row as Event, author);
      }
    });
  }
}
