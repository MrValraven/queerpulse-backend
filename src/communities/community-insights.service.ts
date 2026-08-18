import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, MoreThanOrEqual, Repository } from 'typeorm';
import { CommunityInsightsResponse } from './community-insights-response';
import {
  CommunityMember,
  RosterRole,
} from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const MONTH_MS = 30 * 24 * 60 * 60 * 1000;

const STAFF_ROLES: readonly RosterRole[] = [RosterRole.Owner, RosterRole.Mod];

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
    const weekAgo = new Date(Date.now() - WEEK_MS);
    const monthAgo = new Date(Date.now() - MONTH_MS);

    const [
      memberCount,
      newMembersThisWeek,
      newMembersThisMonth,
      postCount,
      postsThisWeek,
      postAuthorRows,
      replyAuthorRows,
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
