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
}
