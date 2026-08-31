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
import { Event } from '../events/entities/event.entity';
import { CommunityActivityCounterService } from './community-activity-counter.service';
import { CommunityAutoFreezeService } from './community-auto-freeze.service';
import { CommunityBanRatificationController } from './community-ban-ratification.controller';
import { CommunityBanRatificationService } from './community-ban-ratification.service';
import { CommunityBansController } from './community-bans.controller';
import { CommunityBansService } from './community-bans.service';
import { CommunityDigestService } from './community-digest.service';
import { CommunityGovernanceHistoryController } from './community-governance-history.controller';
import { CommunityGovernanceHistoryService } from './community-governance-history.service';
import { CommunityInvitesController } from './community-invites.controller';
import { CommunityInvitesService } from './community-invites.service';
import { CommunityOwnerInactivityService } from './community-owner-inactivity.service';
import { CommunityOwnerReviewController } from './community-owner-review.controller';
import { CommunityOwnerReviewService } from './community-owner-review.service';
import { CommunityResourcesController } from './community-resources.controller';
import { CommunityResourcesService } from './community-resources.service';
import { CommunitySupportOffersController } from './community-support-offers.controller';
import { CommunitySupportOffersService } from './community-support-offers.service';
import { CommunityPreferencesController } from './community-preferences.controller';
import { CommunityPreferencesService } from './community-preferences.service';
import { CommunityPublicController } from './community-public.controller';
import { CommunityPublicService } from './community-public.service';
import { MeCommunityDigestController } from './me-community-digest.controller';
import { CommunityGovernanceLogService } from './community-governance-log.service';
import { CommunityInsightsController } from './community-insights.controller';
import { CommunityInsightsService } from './community-insights.service';
import { CommunityMembershipModule } from './community-membership.module';
import { CommunityOwnerOrphanService } from './community-owner-orphan.service';
import { CommunityPostsController } from './community-posts.controller';
import { CommunityPostsService } from './community-posts.service';
import { CommunityPulseController } from './community-pulse.controller';
import { CommunityPulseService } from './community-pulse.service';
import { CommunityBan } from './entities/community-ban.entity';
import { CommunityBanRatification } from './entities/community-ban-ratification.entity';
import { CommunityGovernanceLog } from './entities/community-governance-log.entity';
import { CommunityOwnerReviewRequest } from './entities/community-owner-review-request.entity';
import { CommunityResource } from './entities/community-resource.entity';
import { CommunitySupportOffer } from './entities/community-support-offer.entity';
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
      // Removal bars return by default, so a ban row is written on the way
      // out (`CommunitiesService.removeMember`) and read back by the
      // owner/mod ban list and the join gate.
      CommunityBan,
      // PRD-25. Where a PERMANENT bar waits for its second signature. Written
      // on the way out of a removal that asked for one and read by the
      // community's own ratification pane; the 30-day bar it settles at is
      // already on the `CommunityBan` row above, so nothing here enforces
      // anything by itself.
      CommunityBanRatification,
      // The owner-editable link shelf on the About tab, which until now could
      // only ever show demo fixtures.
      CommunityResource,
      // What platform staff have offered this community (OPS-05). Written on
      // the admin side (`AdminCommunitiesModule` registers its own
      // `forFeature` for the same entity, the precedent every other shared
      // community entity here follows); read and answered on this side, by
      // the community's own owner/co-owners/mods.
      CommunitySupportOffer,
      // Any roster member flagging an unreachable owner (GOV-02; it was
      // moderators only, which left a room with no moderator no route at
      // all). Stamps the community's existing `needsOwnerReviewAt` for the
      // admin surface.
      CommunityOwnerReviewRequest,
      Profile,
      // Read-only, for the auto-freeze listener's open-report count. Same
      // cross-module `forFeature` reuse `ReportsModule` itself does with
      // `Message`/`HousingListing` — TypeORM allows an entity's repo in more
      // than one module.
      Report,
      // Read-only, for `CommunityDigestService`'s upcoming-gathering counts
      // and `CommunityPublicService`'s next-public-gathering lookup.
      // Importing `EventsModule` (already done below, for the pulse service)
      // provides the service and never the repository, so the entity has to
      // be listed here. Same cross-module `forFeature` reuse as `Report`.
      Event,
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
    // The caller's own per-community notification level plus the one-time
    // welcome acknowledgement. Its own controller for the same reason as the
    // two above: this feature's read side never has to touch
    // `CommunitiesController`.
    CommunityPreferencesController,
    // `GET /me/communities/digest`, the live weekly digest across every
    // community the caller belongs to.
    MeCommunityDigestController,
    // `GET /communities/:slug/public`, the only signed-out-reachable
    // community surface. Deliberately its own controller with NO class-level
    // `ActiveMemberGuard`, matching `DirectoryController` and
    // `RoadmapPublicController`. Do not merge it into a guarded controller.
    CommunityPublicController,
    // Owner/mod surfaces that likewise keep off `CommunitiesController`.
    CommunityResourcesController,
    CommunityInvitesController,
    CommunityBansController,
    CommunityBanRatificationController,
    CommunityOwnerReviewController,
    CommunitySupportOffersController,
    // A community's own staff reading their own audit trail. Until now the
    // only reader was the platform-admin route, so when two moderators
    // disagreed about who removed whom the answer sat in the database
    // reachable only by staff.
    CommunityGovernanceHistoryController,
  ],
  providers: [
    CommunitiesService,
    CommunityPostsService,
    CommunityAutoFreezeService,
    CommunityGovernanceLogService,
    CommunityOwnerOrphanService,
    CommunityPulseService,
    CommunityInsightsService,
    CommunityPreferencesService,
    CommunityDigestService,
    CommunityPublicService,
    // Hourly `@Cron` recompute of `communities.active_this_week`, so discover
    // can sort and filter on the column server-side instead of draining every
    // page to the browser. `ScheduleModule.forRoot()` is already registered in
    // `AppModule`, so a `@Cron` provider only needs to appear here (same
    // precedent as `HousingListingExpirySweeperService`).
    CommunityActivityCounterService,
    // GOV-02: daily `@Cron` that stamps `needs_owner_review_at` on any
    // community whose owner's sessions have gone quiet past the inactivity
    // cutoff, so an abandoned room reaches the admin queue even when nobody
    // in it thinks to report it. Registered as a plain provider for the same
    // reason as the counter above: `ScheduleModule.forRoot()` is already
    // registered once app-wide in `AppModule` and must not be imported here.
    // It reads `refresh_tokens` through a raw query on the `Community`
    // repository's connection, so it needs no extra `forFeature` entry and
    // pulls in no dependency on `AuthModule`.
    CommunityOwnerInactivityService,
    CommunityResourcesService,
    CommunityInvitesService,
    CommunityBansService,
    // PRD-25. Opens, lists, decides and lazily expires the hold a permanent
    // bar now waits in. Injected by `CommunitiesService` (the removal path)
    // and `CommunityBansService` (the "make this permanent" path); it depends
    // on neither, so the graph stays acyclic.
    CommunityBanRatificationService,
    CommunityOwnerReviewService,
    CommunityGovernanceHistoryService,
    CommunitySupportOffersService,
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
