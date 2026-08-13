import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, Repository } from 'typeorm';
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
import {
  Event,
  EventStatus,
  EventVisibility,
} from '../events/entities/event.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { BlockFilterService } from '../social/block-filter.service';
import { Profile } from '../users/entities/profile.entity';
import { UserStatus } from '../users/entities/user.entity';
import { FeedTab } from './dto/get-feed.query';
import {
  communityNewMemberToFeedItem,
  communityPostToFeedItem,
  eventToFeedItem,
  FeedItem,
  forumThreadToFeedItem,
  newMemberToFeedItem,
} from './feed-response';

const DEFAULT_LIMIT = 20;

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
  authorId: string;
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
    private readonly blockFilter: BlockFilterService,
  ) {}

  async getFeed(
    viewerId: string,
    tab: FeedTab | undefined,
    cursor: string | undefined,
    limit: number = DEFAULT_LIMIT,
  ): Promise<CursorPage<FeedItem>> {
    const resolvedTab = tab ?? 'all';
    const sources = this.sourcesForTab(resolvedTab);
    // Personalizes the community_post/gathering/forum_thread source cases to
    // the viewer's own memberships when serving the `communities` tab (Task
    // 6) — see the per-case `if (membershipScoped)` branches below.
    // `community_new_member` needs no branch: it's already inherently
    // viewer-scoped (Task 5).
    const membershipScoped = resolvedTab === 'communities';

    const perSourceLimit = limit + 1;
    const candidateLists = await Promise.all(
      sources.map((source) =>
        this.fetchCandidates(
          source,
          viewerId,
          cursor,
          perSourceLimit,
          membershipScoped,
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
    const data = await this.toFeedItems(visible);

    return { data, pageInfo: { nextCursor, hasMore } };
  }

  // --- internals ---

  /** `tab` -> which sources are unioned. `people` unions just `new_member`;
   * `all` includes it alongside the other three, so recently-joined members
   * surface in the unfiltered feed too. `communities` unions all four
   * membership-scoped sources (Task 6) — note it uses
   * `community_new_member`, NOT the global `new_member` that `all`/`people`
   * use, since this tab is personalized to the viewer's own communities. */
  private sourcesForTab(tab: FeedTab): SourceKind[] {
    switch (tab) {
      case 'communities':
        return [
          'community_post',
          'gathering',
          'forum_thread',
          'community_new_member',
        ];
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
  ): Promise<Candidate[]> {
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
        if (membershipScoped) {
          // `communities` tab (Task 6): restrict to threads posted in
          // communities the viewer belongs to.
          qb.andWhere(
            `t.community_id IS NOT NULL AND EXISTS (
               SELECT 1 FROM "community_members" "mem"
               WHERE "mem"."community_id" = t.community_id AND "mem"."user_id" = :viewerId)`,
            { viewerId },
          );
        }
        // `true`: `ForumThread.createdAt` is migrated to `timestamptz(3)`
        // (see `1785001400000-NarrowCursorCreatedAtPrecision.ts`), so this
        // unfiltered "no WHERE at all" scan can finally use the existing
        // `IDX_forum_thread_created_at_id` (`1782800210000-AddForum.ts`) —
        // that index was already shaped correctly but unusable while this
        // query's ORDER BY/WHERE went through the non-indexable
        // `date_trunc(...)` wrapper.
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
    const authorIds = [...new Set(candidates.map((c) => c.authorId))];
    const hiddenAuthorIds = await this.blockFilter.hiddenUserIds(
      viewerId,
      authorIds,
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

    // Both `community_post` (nullable `communityId` — a flat/global post has
    // none) and `community_new_member` (always scoped to a community) need a
    // community row resolved; batched into the same `IN` query/map as
    // `authors` above rather than one lookup per source.
    const communityIds = [
      ...new Set(
        candidates
          .map((c) => {
            if (c.type === 'community_post') {
              return (c.row as CommunityPost).communityId;
            }
            if (c.type === 'community_new_member') {
              return (c.row as CommunityMember).communityId;
            }
            return null;
          })
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
        case 'new_member':
          return newMemberToFeedItem(c.row as Profile, author);
        case 'community_new_member': {
          const membership = c.row as CommunityMember;
          const community = communityById.get(membership.communityId) ?? null;
          return communityNewMemberToFeedItem(
            c.id,
            c.createdAt,
            author,
            community,
          );
        }
      }
    });
  }
}
