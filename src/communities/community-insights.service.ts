import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import {
  CommunityInsightsResponse,
  CommunityTrendPoint,
  INSIGHTS_TREND_WEEKS,
} from './community-insights-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

// `co_owner` is a member the owner handed owner-level powers to inside the
// community (see `RosterRole.CoOwner`), so it reads insights exactly as
// `owner` does.
const STAFF_ROLES: readonly RosterRole[] = [
  RosterRole.Owner,
  RosterRole.CoOwner,
  RosterRole.Mod,
];

/**
 * The Monday 00:00 UTC that starts the ISO calendar week containing `date`.
 * UTC and Monday-based on both sides of the boundary: the SQL below truncates
 * with `date_trunc('week', ... AT TIME ZONE 'UTC')`, which is also Monday-based
 * in Postgres, so a bucket key produced here always matches a bucket key
 * produced there.
 */
function startOfIsoWeekUtc(date: Date): Date {
  const dayStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
  const offsetToMonday = (dayStart.getUTCDay() + 6) % 7;
  dayStart.setUTCDate(dayStart.getUTCDate() - offsetToMonday);
  return dayStart;
}

/** `YYYY-MM-DD`, the bucket key shape `CommunityTrendPoint.weekStart` carries. */
function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/**
 * The `INSIGHTS_TREND_WEEKS` week-start keys the series must cover, oldest
 * first, ending with the week `now` falls in (which is partial and counts
 * whatever has landed so far).
 */
function trendWeekStarts(now: Date): string[] {
  const currentWeekStart = startOfIsoWeekUtc(now);
  const weekStarts: string[] = [];
  for (let index = INSIGHTS_TREND_WEEKS - 1; index >= 0; index -= 1) {
    const weekStart = new Date(currentWeekStart);
    weekStart.setUTCDate(weekStart.getUTCDate() - index * 7);
    weekStarts.push(toIsoDate(weekStart));
  }
  return weekStarts;
}

/**
 * Turns the sparse `{weekStart, count}` rows one grouped query returned into a
 * dense series with a zero for every week the query had nothing for. Done in
 * application code precisely so the database side stays ONE grouped query
 * rather than a generate_series join or, far worse, a query per week.
 */
function fillWeeks(
  weekStarts: string[],
  rows: { weekStart: string; count: string }[],
): CommunityTrendPoint[] {
  const countsByWeek = new Map<string, number>(
    rows.map((row) => [row.weekStart, Number(row.count)]),
  );
  return weekStarts.map((weekStart) => ({
    weekStart,
    count: countsByWeek.get(weekStart) ?? 0,
  }));
}

/**
 * Backs `GET /communities/:slug/insights` — a lightweight aggregate-stats
 * read for a community's own owner/mods, who currently have nothing beyond
 * the raw live member count. Every metric is a plain grouped/batched count
 * (never per-member behavior tracking) computed via directly-injected
 * repositories against `community_members`/`community_posts`/
 * `community_post_replies` — the same "one query per metric, run in
 * parallel" discipline `CommunitiesService.statsForMany` already uses, kept
 * local here rather than reused from that service since this endpoint's
 * files are deliberately new (see this feature's own module doc).
 *
 * The two 12-week trend series (`newMembersByWeek`/`postsByWeek`) hold that
 * same line: each is ONE grouped `date_trunc('week', ...)` query returning
 * volumes per week, densified to a full 12 points in Node. They answer
 * "is this community growing or fading", and they carry no per-member
 * dimension at all, which is not an oversight to be corrected later. Tracking
 * an individual's activity is out of bounds on this platform.
 */
@Injectable()
export class CommunityInsightsService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
    @InjectRepository(CommunityPost)
    private readonly posts: Repository<CommunityPost>,
    @InjectRepository(CommunityPostReply)
    private readonly replies: Repository<CommunityPostReply>,
  ) {}

  async getInsightsBySlug(
    slug: string,
    userId: string,
  ): Promise<CommunityInsightsResponse> {
    const communityId = await this.resolveStaffCommunityId(slug, userId);
    const now = new Date();
    const weekAgo = new Date(now.getTime() - WEEK_MS);
    const monthAgo = new Date(now.getTime() - MONTH_MS);
    // The 12 bucket keys the two series must cover, and the instant the oldest
    // of them begins. Both grouped queries below filter on that instant, so
    // neither ever scans further back than the window it renders.
    const weekStarts = trendWeekStarts(now);
    const trendSince = new Date(`${weekStarts[0]}T00:00:00.000Z`);

    const [
      memberCount,
      newMembersThisWeek,
      newMembersThisMonth,
      postCount,
      postsThisWeek,
      postAuthorRows,
      replyAuthorRows,
      newMemberWeekRows,
      postWeekRows,
    ] = await Promise.all([
      this.members.count({ where: { communityId } }),
      this.members.count({
        where: { communityId, joinedAt: MoreThanOrEqual(weekAgo) },
      }),
      this.members.count({
        where: { communityId, joinedAt: MoreThanOrEqual(monthAgo) },
      }),
      this.posts.count({ where: { communityId, deletedAt: IsNull() } }),
      this.posts.count({
        where: {
          communityId,
          deletedAt: IsNull(),
          createdAt: MoreThanOrEqual(weekAgo),
        },
      }),
      // Distinct post authors in the last 7 days — half of the
      // `activeMemberCount7d` union (see below). `author_id` can be `NULL`
      // (an erased author — see `CommunityPost.authorId`'s doc comment),
      // which never counts as "active".
      this.posts
        .createQueryBuilder('p')
        .select('DISTINCT p.author_id', 'authorId')
        .where('p.community_id = :communityId', { communityId })
        .andWhere('p.author_id IS NOT NULL')
        .andWhere('p.deleted_at IS NULL')
        .andWhere('p.created_at >= :since', { since: weekAgo })
        .getRawMany<{ authorId: string }>(),
      // The reply half of the same union — replies don't carry `community_id`
      // directly, so this joins through their parent post to scope them.
      this.replies
        .createQueryBuilder('r')
        .innerJoin(CommunityPost, 'p', 'p.id = r.post_id')
        .select('DISTINCT r.author_id', 'authorId')
        .where('p.community_id = :communityId', { communityId })
        .andWhere('r.author_id IS NOT NULL')
        .andWhere('r.deleted_at IS NULL')
        .andWhere('r.created_at >= :since', { since: weekAgo })
        .getRawMany<{ authorId: string }>(),
      // TREND, query 1 of 2: new members per ISO week over the trend window,
      // as ONE grouped query. `date_trunc('week', ...)` buckets server-side
      // and `GROUP BY` collapses each week to a single row, so twelve points
      // cost one round trip and the sparse result is densified in Node (see
      // `fillWeeks`). A per-week count would have been twelve queries.
      this.members
        .createQueryBuilder('m')
        .select(
          "to_char(date_trunc('week', m.joined_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
          'weekStart',
        )
        .addSelect('COUNT(*)', 'count')
        .where('m.community_id = :communityId', { communityId })
        .andWhere('m.joined_at >= :since', { since: trendSince })
        .groupBy("date_trunc('week', m.joined_at AT TIME ZONE 'UTC')")
        .getRawMany<{ weekStart: string; count: string }>(),
      // TREND, query 2 of 2: posts per ISO week over the same window, same
      // single-grouped-query shape. Tombstoned posts are excluded so the line
      // matches `postCount` above.
      this.posts
        .createQueryBuilder('p')
        .select(
          "to_char(date_trunc('week', p.created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
          'weekStart',
        )
        .addSelect('COUNT(*)', 'count')
        .where('p.community_id = :communityId', { communityId })
        .andWhere('p.deleted_at IS NULL')
        .andWhere('p.created_at >= :since', { since: trendSince })
        .groupBy("date_trunc('week', p.created_at AT TIME ZONE 'UTC')")
        .getRawMany<{ weekStart: string; count: string }>(),
    ]);

    // Two queries, merged here rather than a single UNION query — plenty for
    // a "last 7 days in one community" id set, and keeps each half a plain
    // indexed lookup instead of a combined query TypeORM's query builder
    // can't express cleanly across two different tables.
    const activeMemberCount7d = new Set([
      ...postAuthorRows.map((row) => row.authorId),
      ...replyAuthorRows.map((row) => row.authorId),
    ]).size;

    return {
      memberCount,
      newMembersThisWeek,
      newMembersThisMonth,
      postCount,
      postsThisWeek,
      activeMemberCount7d,
      newMembersByWeek: fillWeeks(weekStarts, newMemberWeekRows),
      postsByWeek: fillWeeks(weekStarts, postWeekRows),
    };
  }

  /**
   * Resolves a community by slug (404 for unknown/archived — same
   * "don't leak existence" posture as `CommunityMembershipService
   * .assertMemberBySlug`) and asserts the caller holds `owner`/`mod` on its
   * roster (403 otherwise), returning the community's id. Kept local rather
   * than added to `CommunityMembershipService` (which only exposes a plain
   * roster-membership check, not a role-aware one) so that shared,
   * cross-feature module stays untouched by this endpoint.
   */
  private async resolveStaffCommunityId(
    slug: string,
    userId: string,
  ): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (!membership || !STAFF_ROLES.includes(membership.role)) {
      throw new ForbiddenException('Owner or moderator role required');
    }
    return community.id;
  }
}
