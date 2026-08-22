import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ConnectionsModule } from '../connections/connections.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { EventsModule } from '../events/events.module';
import { ForumModule } from '../forum/forum.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { MentionsModule } from '../mentions/mentions.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { Report } from '../reports/entities/report.entity';
import { SocialModule } from '../social/social.module';
import { StorageModule } from '../storage/storage.module';
import { Profile } from '../users/entities/profile.entity';
import { UsersModule } from '../users/users.module';
import { VolunteeringModule } from '../volunteering/volunteering.module';
import { CommunitiesController } from './communities.controller';
import { CommunitiesService } from './communities.service';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityInsightsController } from './community-insights.controller';
import { CommunityInsightsService } from './community-insights.service';
import { CommunityMembershipModule } from './community-membership.module';
import { CommunityOwnerOrphanService } from './community-owner-orphan.service';
import { CommunityPostsController } from './community-posts.controller';
import { CommunityPostsService } from './community-posts.service';
import { CommunityPulseController } from './community-pulse.controller';
import { CommunityPulseService } from './community-pulse.service';
import { CommunityGovernanceLog } from './entities/community-governance-log.entity';
import { CommunityJoinRequest } from './entities/community-join-request.entity';
import { CommunityMember } from './entities/community-member.entity';
import { CommunityPostEdit } from './entities/community-post-edit.entity';
import { CommunityPostReaction } from './entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from './entities/community-post-reply-edit.entity';
import { CommunityPostReply } from './entities/community-post-reply.entity';
import { CommunityPost } from './entities/community-post.entity';
import { CommunityTagRequest } from './entities/community-tag-request.entity';
import { Community } from './entities/community.entity';
import { MeCommunitiesController } from './me-communities.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Community,
      CommunityMember,
      CommunityPost,
      CommunityPostReaction,
      CommunityPostReply,
      CommunityPostEdit,
      CommunityPostReplyEdit,
      CommunityJoinRequest,
      // The owner/mod "suggest a tag" feedback inbox
      // (`CommunitiesService.createTagRequest`) — read+written here on the
      // member side; `AdminCommunitiesModule` registers its own `forFeature`
      // for the admin-side review queue, same precedent as
      // `CommunityJoinRequest`/`Community` there.
      CommunityTagRequest,
      // The owner-erasure audit trail (`CommunityGovernanceLogService`) and,
      // via `CommunityOwnerOrphanService`, the sink for automatic owner→mod
      // promotion entries.
      CommunityGovernanceLog,
      Profile,
      // Read-only, for the auto-freeze listener's open-report count. Same
      // cross-module `forFeature` reuse `ReportsModule` itself does with
      // `Message`/`HousingListing` — TypeORM allows an entity's repo in more
      // than one module.
      Report,
    ]),
    UsersModule,
    // `ConnectionsService` — `suggestedCommunities` reads the viewer's accepted
    // connections (the real social-graph signal; see that method's doc
    // comment) to find communities their connections have joined. `ConnectionsModule`
    // imports only `UsersModule`/`SocialModule`/`VouchModule`, none of which
    // import `CommunitiesModule`, so this closes no cycle.
    ConnectionsModule,
    // `BlockFilterService` — community post feeds and their nested replies
    // exclude blocked/muted authors. Plain import (no `forwardRef`):
    // `SocialModule` pulls in only `UsersModule` + `ReportsModule`.
    SocialModule,
    // `MentionNotificationService` — `@mention`/`c/community` fan-out on
    // post/reply create. Plain import, no `forwardRef`: `MentionsModule`
    // imports only entity repos + `NotificationsModule`, not `CommunitiesModule`.
    MentionsModule,
    // `ContentModerationService` — community post/reply reads honour a
    // moderator `hide_content`/`remove_content` takedown (hidden withheld from
    // members, removed rendered as a tombstone).
    ContentModerationModule,
    // `NotificationsService` — `CommunitiesService` emits join-request
    // received (owner/mods) + decided (applicant). (The community-post-reply
    // notification goes through `MentionNotificationService` above.)
    // `NotificationsModule` imports only `SocialModule`, not `CommunitiesModule`,
    // so there is no cycle.
    NotificationsModule,
    // `StorageService` — delete a post's previous image object when an author
    // replaces or clears it on edit, so the superseded upload stops orphaning.
    StorageModule,
    // Batched crop lookup (`MediaCropService.getMany`) for `coverImageUrl`'s
    // sibling `coverCrop`.
    MediaCropsModule,
    // `CommunityMembershipService` — backs `CommunityPulseService`'s
    // resolve-slug-and-assert-roster-member check
    // (`assertMemberBySlug`), the same cross-feature pattern
    // `EventsModule`/`ForumModule`/`VolunteeringModule` already reuse it for.
    // Read-only module; closes no cycle.
    CommunityMembershipModule,
    // `EventsService`/`ForumThreadsService`/`VolunteeringService` — the three
    // `listUpcomingByCommunity`/`listRecentByCommunity`/`listOpenByCommunity`
    // lanes `CommunityPulseService` fans out to in parallel. None of these
    // three modules imports `CommunitiesModule` (only the leaf
    // `CommunityMembershipModule`), so this closes no cycle.
    EventsModule,
    ForumModule,
    VolunteeringModule,
  ],
  controllers: [
    CommunitiesController,
    CommunityPostsController,
    MeCommunitiesController,
    // `communities/:slug/pulse` / `communities/:slug/insights` — deliberately
    // their own controllers (not methods on `CommunitiesController`), so this
    // feature's read side never has to touch that file. See each
    // controller's own doc comment.
    CommunityPulseController,
    CommunityInsightsController,
  ],
  providers: [
    CommunitiesService,
    CommunityPostsService,
    CommunityAutoFreezeService,
    CommunityGovernanceLogService,
    CommunityOwnerOrphanService,
    CommunityPulseService,
    CommunityInsightsService,
  ],
  // `CommunityOwnerOrphanService` is exported so `AccountModule` can call
  // `handleOwnerErasure(userId)` from `AccountDeletionProcessorService.eraseAccount`,
  // immediately before the hard-delete of the `User` row — see that service's
  // own docstring for why the call has to land there. No circular dependency:
  // nothing this module imports (directly or transitively) imports
  // `AccountModule`.
  //
  // `CommunityGovernanceLogService` is exported so `MembershipCardsModule`
  // can write to the same owner/mod audit trail from `CardProgramsService`
  // (programme enable/disable) and `MembershipCardsService` (card
  // suspend/revoke/reinstate). Same no-cycle argument: nothing this module
  // imports, directly or transitively, imports `MembershipCardsModule`.
  exports: [
    CommunitiesService,
    CommunityOwnerOrphanService,
    CommunityGovernanceLogService,
  ],
})
export class CommunitiesModule {}
