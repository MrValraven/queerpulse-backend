import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AdminCommunitiesModule } from '../admin-communities/admin-communities.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AdminOverviewController } from './admin-overview.controller';
import { AdminOverviewService } from './admin-overview.service';

@Module({
  imports: [
    // Own `forFeature` for every entity `AdminOverviewService` reads
    // directly — follows `AdminMembersModule`'s precedent of registering
    // its own copies rather than depending on other modules' re-exports
    // (TypeORM permits overlapping registrations across modules).
    TypeOrmModule.forFeature([
      Profile,
      Report,
      PlatformJoinRequest,
      Appeal,
      ModAuditLog,
      Vouch,
      CommunityMember,
      Community,
    ]),
    // `UsersModule` exports `UsersService` (and `TypeOrmModule`), which
    // `AdminOverviewService` injects directly for `countActiveMembers`.
    UsersModule,
    // Exports `AdminCommunitiesService`, which `AdminOverviewService` injects
    // directly to reuse its already-computed per-community health score
    // (see that module's `exports` comment).
    AdminCommunitiesModule,
  ],
  controllers: [AdminOverviewController],
  providers: [AdminOverviewService],
})
export class AdminOverviewModule {}
