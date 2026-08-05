import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMembershipService } from './community-membership.service';
import { CommunityMember } from './entities/community-member.entity';
import { Community } from './entities/community.entity';

/**
 * Read-only `forFeature` registration for `CommunityMembershipService`.
 * Deliberately does NOT import `CommunitiesModule` — feature modules (events,
 * forum threads, ...) that only need the resolve-and-assert-roster-member
 * check should import THIS module instead of pulling in the full communities
 * feature surface.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Community, CommunityMember])],
  providers: [CommunityMembershipService],
  exports: [CommunityMembershipService],
})
export class CommunityMembershipModule {}
