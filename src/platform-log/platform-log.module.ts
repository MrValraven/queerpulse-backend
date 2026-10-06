import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { GovernanceFinanceChange } from '../governance/entities/governance-finance-change.entity';
import { GovernanceOverviewChange } from '../governance/entities/governance-overview-change.entity';
import { ListingModerationEvent } from '../listings/entities/listing-moderation-event.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import { PlatformSettingChange } from '../platform-settings/entities/platform-setting-change.entity';
import { Report } from '../reports/entities/report.entity';
import { RoadmapAuditLog } from '../roadmap/entities/roadmap-audit-log.entity';
import { SafeSpaceDecisionAudit } from '../safe-space-nominations/entities/safe-space-decision-audit.entity';
import { Profile } from '../users/entities/profile.entity';
import { VerificationEvent } from '../verification/entities/verification-event.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { PlatformLogController } from './platform-log.controller';
import { PlatformLogService } from './platform-log.service';
import {
  PLATFORM_LOG_SOURCES,
  type PlatformLogSource,
} from './platform-log.types';
import { CommunityJoinSource } from './sources/community-join.source';
import { ForumThreadSource } from './sources/forum-thread.source';
import { GovernanceFinanceChangeSource } from './sources/governance-finance-change.source';
import { GovernanceOverviewChangeSource } from './sources/governance-overview-change.source';
import { JoinRequestSource } from './sources/join-request.source';
import { ListingModerationEventSource } from './sources/listing-moderation-event.source';
import { ModAuditLogSource } from './sources/mod-audit-log.source';
import { PlatformSettingChangeSource } from './sources/platform-setting-change.source';
import { ProfileJoinSource } from './sources/profile-join.source';
import { ReportFiledSource } from './sources/report-filed.source';
import { RoadmapAuditLogSource } from './sources/roadmap-audit-log.source';
import { SafeSpaceDecisionAuditSource } from './sources/safe-space-decision-audit.source';
import { VerificationEventSource } from './sources/verification-event.source';
import { VouchSource } from './sources/vouch.source';

const SOURCE_CLASSES = [
  ModAuditLogSource,
  GovernanceOverviewChangeSource,
  GovernanceFinanceChangeSource,
  PlatformSettingChangeSource,
  RoadmapAuditLogSource,
  VerificationEventSource,
  SafeSpaceDecisionAuditSource,
  ListingModerationEventSource,
  ProfileJoinSource,
  VouchSource,
  CommunityJoinSource,
  ReportFiledSource,
  JoinRequestSource,
  ForumThreadSource,
];

/**
 * `GET /admin/log`. Registers its own `forFeature` copies of every source
 * entity (the same pattern as AdminOverviewModule); joined-only entities
 * (Listing, User, Community) need no registration for `leftJoin(Entity, ...)`.
 * Unlike `AdminOverviewModule`, nothing here injects `UsersService`, so there
 * is no `UsersModule` import: `PlatformLogService` resolves names through its
 * own `Profile` repository (registered below).
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      ModAuditLog,
      GovernanceOverviewChange,
      GovernanceFinanceChange,
      PlatformSettingChange,
      RoadmapAuditLog,
      VerificationEvent,
      SafeSpaceDecisionAudit,
      ListingModerationEvent,
      Profile,
      Vouch,
      CommunityMember,
      Report,
      PlatformJoinRequest,
      ForumThread,
    ]),
  ],
  controllers: [PlatformLogController],
  providers: [
    ...SOURCE_CLASSES,
    {
      provide: PLATFORM_LOG_SOURCES,
      useFactory: (...sources: PlatformLogSource[]) => sources,
      inject: SOURCE_CLASSES,
    },
    PlatformLogService,
  ],
})
export class PlatformLogModule {}
