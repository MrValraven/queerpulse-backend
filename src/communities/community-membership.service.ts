import {
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { IsNull, Repository } from 'typeorm';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Shared "resolve a community by slug, then assert the caller is on its
 * roster" step, reused by feature modules (events, forum threads, ...) that
 * need this exact check without importing the whole `CommunitiesModule` or
 * duplicating `CommunityPostsService`'s own private `loadCommunityOr404` /
 * `assertMember` pair. Kept read-only and dependency-light on purpose: this
 * module only registers `Community`/`CommunityMember` via
 * `TypeOrmModule.forFeature`.
 */
@Injectable()
export class CommunityMembershipService {
  constructor(
    @InjectRepository(Community)
    private readonly communities: Repository<Community>,
    @InjectRepository(CommunityMember)
    private readonly members: Repository<CommunityMember>,
  ) {}

  /**
   * Resolve a community by slug and assert the given user is on its roster.
   * A missing or archived community 404s (existence isn't leaked); a
   * resolved-but-non-member caller gets a 403. Returns the community's id for
   * the caller to scope its own write with.
   */
  async assertMemberBySlug(slug: string, userId: string): Promise<string> {
    const community = await this.communities.findOne({
      where: { slug, archivedAt: IsNull() },
    });
    if (!community) {
      throw new NotFoundException('Community not found');
    }
    const membership = await this.members.findOne({
      where: { communityId: community.id, userId },
    });
    if (!membership) {
      throw new ForbiddenException('Only roster members can do that');
    }
    return community.id;
  }

  /**
   * Plain boolean roster check by community id (no slug resolution, no throw)
   * — backs `EventVisibility.Community`'s tier check
   * (`EventAudienceGateService.assertViewable`, shared by
   * `EventsService.assertCanView` and `RsvpService`'s RSVP gate), which
   * already has the event's `communityId` and just needs "is this viewer on
   * the roster?".
   */
  async isMember(communityId: string, userId: string): Promise<boolean> {
    return this.members.exists({ where: { communityId, userId } });
  }

  /**
   * Every community id the given user is on the roster of — backs the
   * `community` OR-in predicate on the gatherings browse/search queries
   * (`EventsService.list`/`searchByText`), computed once per request via the
   * indexed `IDX_community_members_user_id` lookup.
   */
  async communityIdsForUser(userId: string): Promise<string[]> {
    const memberships = await this.members.find({
      where: { userId },
      select: { communityId: true },
    });
    return memberships.map((membership) => membership.communityId);
  }

  /**
   * Resolve a community id straight to its slug — a plain display lookup, no
   * roster/archived check. Backs `EventDetail.communitySlug`
   * (`EventsService.buildDetail`): the edit UI needs the slug (not just the
   * id already on `EventSummary`/`EventDetail` as `communityId`) to offer the
   * `community` audience-scope tier for an event that already has one.
   * Returns `null` for an unknown id (shouldn't happen for a real
   * `event.communityId`, but this is a display convenience, not a guard, so
   * it fails soft rather than throwing).
   */
  async slugById(communityId: string): Promise<string | null> {
    const community = await this.communities.findOne({
      where: { id: communityId },
      select: { slug: true },
    });
    return community?.slug ?? null;
  }
}
