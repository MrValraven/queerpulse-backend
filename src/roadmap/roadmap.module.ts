import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Profile } from '../users/entities/profile.entity';
import { RoadmapItem } from './entities/roadmap-item.entity';
import { RoadmapIdea } from './entities/roadmap-idea.entity';
import { RoadmapVote } from './entities/roadmap-vote.entity';
import { RoadmapSettings } from './entities/roadmap-settings.entity';
import { RoadmapTeamMember } from './entities/roadmap-team-member.entity';
import { RoadmapItemComment } from './entities/roadmap-item-comment.entity';
import { RoadmapAuditLog } from './entities/roadmap-audit-log.entity';
import { RoadmapItemDependency } from './entities/roadmap-item-dependency.entity';
import { RoadmapService } from './roadmap.service';
import { RoadmapAdminService } from './roadmap-admin.service';
import { RoadmapController } from './roadmap.controller';
import { RoadmapPublicController } from './roadmap-public.controller';
import { AdminRoadmapController } from './admin-roadmap.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      RoadmapItem,
      RoadmapIdea,
      RoadmapVote,
      RoadmapSettings,
      RoadmapTeamMember,
      RoadmapItemComment,
      RoadmapAuditLog,
      RoadmapItemDependency,
      // `RoadmapAdminService` resolves owner/team member display names via
      // `MemberLookup` (never stores them) and computes each item's vote
      // `voteBreakdown` by joining voters to their communities — neither
      // entity has its own module exported here, so (matching
      // `AdminTrustNetworkModule`/`CommunitiesModule`'s convention) they're
      // registered directly in this module's own `forFeature` instead.
      Profile,
      CommunityMember,
    ]),
    // `NotificationsService` — tell a member their submitted idea's status
    // changed (published or dismissed).
    NotificationsModule,
  ],
  // `AdminRoadmapController` (`/admin/roadmap/*`) carries the staff routes
  // that used to live on `RoadmapController` under an `admin/*` path prefix —
  // see BE-COM-14. It reuses `RoadmapAdminService`, so it is registered here
  // rather than in a separate top-level module.
  controllers: [
    RoadmapPublicController,
    RoadmapController,
    AdminRoadmapController,
  ],
  providers: [RoadmapService, RoadmapAdminService],
})
export class RoadmapModule {}
