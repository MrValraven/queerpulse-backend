import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipService } from './community-membership.service';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { Community } from './entities/community.entity';

/**
 * Read-only `forFeature` registration for `CommunityMembershipService`.
 * Deliberately does NOT import `CommunitiesModule` — feature modules (events,
 * forum threads, moderation, ...) that only need the
 * resolve-and-assert-roster-member check, the owner-or-mod boolean check, or
 * the post/reply -> owning-community resolution should import THIS module
 * instead of pulling in the full communities feature surface.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      // Read-only: backs `communityIdForPost`/`communityIdForReply`, reused by
      // `ModerationService`'s community-mod dismiss carve-out. TypeORM permits
      // the same entity registered in multiple modules (mirrors
      // `CommunitiesModule`'s own `Report` overlap with `ReportsModule`).
      CommunityPost,
      CommunityPostReply,
    ]),
  ],
  providers: [CommunityMembershipService],
  exports: [CommunityMembershipService],
})
export class CommunityMembershipModule {}
