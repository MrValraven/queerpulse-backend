import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { CommunityGovernanceLogService } from '../communities/community-governance-log.service';
import { CommunityGovernanceLog } from '../communities/entities/community-governance-log.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { CommunitySupportOffer } from '../communities/entities/community-support-offer.entity';
import { CommunityTagRequest } from '../communities/entities/community-tag-request.entity';
import { Community } from '../communities/entities/community.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ReportsModule } from '../reports/reports.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { AdminCommunitiesController } from './admin-communities.controller';
import { AdminCommunitiesService } from './admin-communities.service';
import { AdminCommunityModeratorsController } from './admin-community-moderators.controller';
import { AdminCommunityModeratorsService } from './admin-community-moderators.service';
import { AdminCommunitySupportController } from './admin-community-support.controller';
import { AdminCommunitySupportService } from './admin-community-support.service';
import { AdminCommunityTagRequestsController } from './admin-community-tag-requests.controller';
import { AdminCommunityTagRequestsService } from './admin-community-tag-requests.service';

@Module({
  imports: [
    // Own `forFeature` for the community-side entities (TypeORM permits
    // overlapping registrations — same precedent as `ModerationModule`), plus
    // `ReportsModule` for `Repository<Report>`, which it exports.
    //
    // `CommunityGovernanceLog` and `User` are registered here rather than
    // imported via `CommunitiesModule`: that module exports only
    // `CommunitiesService` (not `CommunityGovernanceLogService` or a
    // `TypeOrmModule` re-export), and the admin freeze/archive/reassign-owner/
    // remove-member actions below deliberately do NOT go through
    // `CommunitiesService` — they bypass its owner/mod-only authorization on
    // purpose (that's the whole point of an admin override), operating on the
    // repositories directly instead. `CommunityGovernanceLogService` only
    // needs `Repository<CommunityGovernanceLog>` (see its constructor), so
    // registering the entity here and instantiating the service as a normal
    // provider is enough — no module import needed.
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReply,
      CommunityGovernanceLog,
      // The "suggest a tag" feedback inbox
      // (`AdminCommunityTagRequestsService`) — own `forFeature` registration
      // here, same precedent as the entities above; `CommunitiesModule`
      // registers it separately for the member-facing write side.
      CommunityTagRequest,
      // Platform staff offering a struggling community support (OPS-05).
      // Written here, read and answered on the community's own side, which
      // registers the same entity in `CommunitiesModule` — the overlapping
      // `forFeature` precedent every shared community entity above follows.
      CommunitySupportOffer,
      Profile,
      User,
    ]),
    ReportsModule,
    // `NotificationsService` — `AdminCommunityTagRequestsService.resolve`
    // notifies the requester when their tag request is resolved, and
    // `AdminCommunitySupportService.create` tells a community's owner,
    // co-owners and moderators that support has been offered.
    NotificationsModule,
  ],
  controllers: [
    AdminCommunitiesController,
    AdminCommunityModeratorsController,
    AdminCommunitySupportController,
    AdminCommunityTagRequestsController,
  ],
  providers: [
    AdminCommunitiesService,
    AdminCommunityModeratorsService,
    AdminCommunitySupportService,
    AdminCommunityTagRequestsService,
    CommunityGovernanceLogService,
  ],
  // `AdminOverviewService` injects `AdminCommunitiesService` directly to
  // reuse its already-computed per-community health score for the overview
  // dashboard's community-health summary, rather than re-deriving the score
  // from a second copy of the aggregation queries — same precedent as
  // `AdminOverviewModule` importing `UsersModule` for `UsersService`.
  exports: [AdminCommunitiesService],
})
export class AdminCommunitiesModule {}
