import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityMembershipModule } from '../communities/community-membership.module';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SocialModule } from '../social/social.module';
import { Profile } from '../users/entities/profile.entity';
import { CommunityBadgeAwardingService } from './community-badge-awarding.service';
import { CommunityBadgeJobsService } from './community-badge-jobs.service';
import { CommunityBadgeTriggersListener } from './community-badge-triggers.listener';
import { CommunityBadgesController } from './community-badges.controller';
import { CommunityBadgesService } from './community-badges.service';
import { CommunityGiftsService } from './community-gifts.service';
import { CommunityBadgeAward } from './entities/community-badge-award.entity';
import { CommunityBadge } from './entities/community-badge.entity';
import { CommunityGift } from './entities/community-gift.entity';

/**
 * Community badges, staff gifts and name flair: the twelve
 * `communities/:slug` routes, the awarding service, the trigger listener and
 * the two scheduled jobs (per-minute silent backfill, daily sweep).
 *
 * This adds the one new module edge of the feature: badges imports
 * communities, the `MembershipCardsModule` precedent, for the exported
 * `CommunityGovernanceLogService`. `CommunitiesModule` never imports this
 * module. It reads name marks through `CommunityNameMarksService`
 * (DataSource only, listed as a plain provider there) and seeds the starter
 * badges through a plain function, so the graph has no cycle and needs no
 * `forwardRef`.
 *
 * `ScheduleModule.forRoot()` and the event emitter are registered once in
 * `AppModule`, so the `@Cron` and `@OnEvent` providers below only need to be
 * listed here.
 *
 * Every injected dependency and where it comes from:
 * - `DataSource`: the global TypeORM root connection.
 * - The `Community`, `CommunityMember`, `CommunityBadge`,
 *   `CommunityBadgeAward`, `CommunityGift` and `Profile` repositories: the
 *   `forFeature` registration below.
 * - `CommunityMembershipService`: `CommunityMembershipModule`.
 * - `CommunityGovernanceLogService`: `CommunitiesModule`.
 * - `ContentModerationService`: `ContentModerationModule`.
 * - `NotificationsService`: `NotificationsModule`.
 * - `BlockFilterService`: `SocialModule`.
 *
 * Exports nothing: reports, takedown and data export reach these tables
 * through plain functions and raw SQL.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      CommunityBadge,
      CommunityBadgeAward,
      CommunityGift,
      Profile,
    ]),
    CommunitiesModule,
    CommunityMembershipModule,
    NotificationsModule,
    SocialModule,
    ContentModerationModule,
  ],
  controllers: [CommunityBadgesController],
  providers: [
    CommunityBadgesService,
    CommunityGiftsService,
    CommunityBadgeAwardingService,
    CommunityBadgeTriggersListener,
    CommunityBadgeJobsService,
  ],
})
export class CommunityBadgesModule {}
