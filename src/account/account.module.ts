import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { CompanyReview } from '../companies/entities/company-review.entity';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { Connection } from '../connections/entities/connection.entity';
import { ConsentRecord } from '../consent/entities/consent-record.entity';
import { PolicyAcceptance } from '../consent/entities/policy-acceptance.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventInvite } from '../events/entities/event-invite.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { EventSeries } from '../events/entities/event-series.entity';
import { Event } from '../events/entities/event.entity';
import { FlatmateLike } from '../flatmate-profiles/entities/flatmate-like.entity';
import { FlatmateProfile } from '../flatmate-profiles/entities/flatmate-profile.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { EventMatchEntry } from '../go-together/entities/event-match-entry.entity';
import { FriendMatchProfile } from '../go-together/entities/friend-match-profile.entity';
import { MatchAvoidance } from '../go-together/entities/match-avoidance.entity';
import { MatchFeedback } from '../go-together/entities/match-feedback.entity';
import { MatchGroupFeedback } from '../go-together/entities/match-group-feedback.entity';
import { GovernanceProposal } from '../governance/entities/governance-proposal.entity';
import { GovernanceVote } from '../governance/entities/governance-vote.entity';
import { GroupJoinRequest } from '../housing-groups/entities/group-join-request.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingReview } from '../housing-reviews/entities/housing-review.entity';
import { HousingSavedSearch } from '../housing-saved-searches/entities/housing-saved-search.entity';
import { HousingViewing } from '../housing-viewings/entities/housing-viewing.entity';
import { CoopJoinRequest } from '../housing/entities/coop-join-request.entity';
import { IdentityBlock } from '../identities/entities/identity-block.entity';
import { IdentitiesModule } from '../identities/identities.module';
import { Job } from '../jobs/entities/job.entity';
import { ListingReview } from '../listings/entities/listing-review.entity';
import { Listing } from '../listings/entities/listing.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { MagazineStorySubmission } from '../magazine/entities/magazine-story-submission.entity';
import { MediaReferencesModule } from '../media-references/media-references.module';
import { MembershipCardsModule } from '../membership-cards/membership-cards.module';
import { Message } from '../messaging/entities/message.entity';
import { NotificationDeliveryPreference } from '../notifications/entities/notification-delivery-preference.entity';
import { NotificationPreference } from '../notifications/entities/notification-preference.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Activity } from '../profiles/entities/activity.entity';
import { ProfileNowHistory } from '../profiles/entities/profile-now-history.entity';
import { PushSubscription } from '../push/entities/push-subscription.entity';
import { Report } from '../reports/entities/report.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { Block } from '../social/entities/block.entity';
import { HiddenFromMember } from '../social/entities/hidden-from.entity';
import { Mute } from '../social/entities/mute.entity';
import { StorageModule } from '../storage/storage.module';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { SubprofilesModule } from '../subprofiles/subprofiles.module';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AccountDeletionProcessorService } from './account-deletion-processor.service';
import { ErasedSenderMessageReleaseService } from './erased-sender-message-release.service';
import { AccountExportService } from './account-export.service';
import { AccountRetentionService } from './account-retention.service';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
import { AccountDependenciesService } from './account-dependencies.service';
import { ContentOwnerErasureService } from './content-owner-erasure.service';
import {
  DATA_EXPORT_CONTRIBUTORS,
  DataExportContribution,
} from './data-export-contributor';
import { NEW_DOMAIN_EXPORT_CONTRIBUTORS } from './data-export-contributors';
import { AccountDeactivation } from './entities/account-deactivation.entity';
import { EmailSuppression } from './entities/email-suppression.entity';
import { AccountReauthToken } from './entities/account-reauth-token.entity';
import { DataExportJob } from './entities/data-export-job.entity';
import { DeletionRequest } from './entities/deletion-request.entity';
import { DsarRequest } from './entities/dsar-request.entity';
import { Affiliation } from '../affiliation/entities/affiliation.entity';
import { Ambassador } from '../ambassadors/entities/ambassador.entity';
import { BarterListing } from '../barter/entities/barter-listing.entity';
import { BarterProposal } from '../barter/entities/barter-proposal.entity';
import { ChangemakerNomination } from '../changemakers/entities/changemaker-nomination.entity';
import { WatchProgress } from '../cinema/entities/watch-progress.entity';
import { CollectionItem } from '../collections/entities/collection-item.entity';
import { Collection } from '../collections/entities/collection.entity';
import { CommunityInvite } from '../communities/entities/community-invite.entity';
import { CommunityJoinRequest } from '../communities/entities/community-join-request.entity';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { CommunityOwnerReviewRequest } from '../communities/entities/community-owner-review-request.entity';
import { CommunityPostEdit } from '../communities/entities/community-post-edit.entity';
import { CommunityPostReaction } from '../communities/entities/community-post-reaction.entity';
import { CommunityPostReplyEdit } from '../communities/entities/community-post-reply-edit.entity';
import { CommunityResource } from '../communities/entities/community-resource.entity';
import { CommunitySpaceRequest } from '../communities/entities/community-space-request.entity';
import { CommunityTagRequest } from '../communities/entities/community-tag-request.entity';
import { CompanyTeamMember } from '../companies/entities/company-team-member.entity';
import { Company } from '../companies/entities/company.entity';
import { ConnectionNote } from '../connections/entities/connection-note.entity';
import { CommissionInterest } from '../culture/entities/commission-interest.entity';
import { Draft } from '../drafts/entities/draft.entity';
import { EventAnnouncement } from '../events/entities/event-announcement.entity';
import { EventBookmark } from '../events/entities/event-bookmark.entity';
import { EventCohostInvite } from '../events/entities/event-cohost-invite.entity';
import { EventLineupEntry } from '../events/entities/event-lineup-entry.entity';
import { EventPhoto } from '../events/entities/event-photo.entity';
import { MemberEventReminderPreferences } from '../events/entities/member-event-reminder-preferences.entity';
import { FeedSourceMute } from '../feed/entities/feed-source-mute.entity';
import { ForumPollVote } from '../forum/entities/forum-poll-vote.entity';
import { ForumPostEdit } from '../forum/entities/forum-post-edit.entity';
import { ForumPostVote } from '../forum/entities/forum-post-vote.entity';
import { ForumThreadSubscription } from '../forum/entities/forum-thread-subscription.entity';
import { GovernanceProposalCosignature } from '../governance/entities/governance-proposal-cosignature.entity';
import { HandleHistory } from '../handles/entities/handle-history.entity';
import { Handle } from '../handles/entities/handle.entity';
import { GroupListing } from '../housing-groups/entities/group-listing.entity';
import { IdentityStaffPreference } from '../identities/entities/identity-staff-preference.entity';
import { IntakeSubmission } from '../intakes/entities/intake-submission.entity';
import { JobApplication } from '../jobs/entities/job-application.entity';
import { LandlordIntroRequest } from '../landlords/entities/landlord-intro-request.entity';
import { LandlordRecommendation } from '../landlords/entities/landlord-recommendation.entity';
import { Landlord } from '../landlords/entities/landlord.entity';
import { ListingDraft } from '../listing-drafts/entities/listing-draft.entity';
import { ListingClaim } from '../listings/entities/listing-claim.entity';
import { ListingCoManager } from '../listings/entities/listing-co-manager.entity';
import { ListingEditSuggestion } from '../listings/entities/listing-edit-suggestion.entity';
import { ListingEnquiry } from '../listings/entities/listing-enquiry.entity';
import { ListingOwnerOffer } from '../listings/entities/listing-owner-offer.entity';
import { ListingPublicQuestion } from '../listings/entities/listing-public-question.entity';
import { ListingReviewHelpfulVote } from '../listings/entities/listing-review-helpful-vote.entity';
import { MagazineArticleComment } from '../magazine/entities/magazine-article-comment.entity';
import { MagazinePieceMessage } from '../magazine/entities/magazine-piece-message.entity';
import { MagazinePitch } from '../magazine/entities/magazine-pitch.entity';
import { MagazineReaderComment } from '../magazine/entities/magazine-reader-comment.entity';
import { MagazineWriterApplication } from '../magazine/entities/magazine-writer-application.entity';
import { MediaCrop } from '../media-crops/entities/media-crop.entity';
import { MemberSuggestionDismissal } from '../member-suggestions/entities/member-suggestion-dismissal.entity';
import { MembershipCardScan } from '../membership-cards/entities/membership-card-scan.entity';
import { MembershipCard } from '../membership-cards/entities/membership-card.entity';
import { Invite } from '../membership/entities/invite.entity';
import { GroupInvite } from '../messaging/entities/group-invite.entity';
import { MessageHide } from '../messaging/entities/message-hide.entity';
import { MessageReaction } from '../messaging/entities/message-reaction.entity';
import { MessageStar } from '../messaging/entities/message-star.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { Partner } from '../partners/entities/partner.entity';
import { MemberPreferences } from '../preferences/entities/member-preferences.entity';
import { BoardPostResponse } from '../profiles/entities/board-post-response.entity';
import { BoardPost } from '../profiles/entities/board-post.entity';
import { GroupMembership } from '../profiles/entities/group-membership.entity';
import { ProfileFeaturedCommunity } from '../profiles/entities/profile-featured-community.entity';
import { ProfileLastActive } from '../profiles/entities/profile-last-active.entity';
import { Shaping } from '../profiles/entities/shaping.entity';
import { Skill } from '../profiles/entities/skill.entity';
import { SocialLink } from '../profiles/entities/social-link.entity';
import { WorkItem } from '../profiles/entities/work-item.entity';
import { ReadingGroupProposal } from '../reading-group-proposals/entities/reading-group-proposal.entity';
import { RecognitionAward } from '../recognition/entities/recognition-award.entity';
import { RecognitionLedgerEntry } from '../recognition/entities/recognition-ledger-entry.entity';
import { RecognitionPerkClaim } from '../recognition/entities/recognition-perk-claim.entity';
import { ResourceGuideRating } from '../resources/entities/resource-guide-rating.entity';
import { ResourceSuggestion } from '../resources/entities/resource-suggestion.entity';
import { RoadmapIdea } from '../roadmap/entities/roadmap-idea.entity';
import { RoadmapItemComment } from '../roadmap/entities/roadmap-item-comment.entity';
import { RoadmapVote } from '../roadmap/entities/roadmap-vote.entity';
import { SafeSpaceFlag } from '../safe-space-nominations/entities/safe-space-flag.entity';
import { SafeSpaceNomination } from '../safe-space-nominations/entities/safe-space-nomination.entity';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { SavedListEntry } from '../saved/entities/saved-list-entry.entity';
import { SavedList } from '../saved/entities/saved-list.entity';
import { SubprofileEndorsement } from '../subprofiles/entities/subprofile-endorsement.entity';
import { SubprofileFollower } from '../subprofiles/entities/subprofile-follower.entity';
import { SubprofileInvite } from '../subprofiles/entities/subprofile-invite.entity';
import { SubprofileMember } from '../subprofiles/entities/subprofile-member.entity';
import { TopicFollow } from '../topics/entities/topic-follow.entity';
import { VerificationRequest } from '../verification/entities/verification-request.entity';
import { MemberVerification } from '../verification/entities/member-verification.entity';
import { VolunteerOpportunityTeam } from '../volunteering/entities/volunteer-opportunity-team.entity';
import { ForumPollOption } from '../forum/entities/forum-poll-option.entity';
import { ForumPoll } from '../forum/entities/forum-poll.entity';
import { VerificationEvent } from '../verification/entities/verification-event.entity';
import { PlatformJoinRequest } from '../membership/entities/join-request.entity';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { MagazinePayment } from '../magazine/entities/magazine-payment.entity';
import { SubprofileItem } from '../subprofiles/entities/subprofile-item.entity';
import { SubprofileSocialLink } from '../subprofiles/entities/subprofile-social-link.entity';
import { SubprofileAffiliation } from '../subprofiles/entities/subprofile-affiliation.entity';

@Module({
  imports: [
    // The account-erasure sweep uses StorageService to delete an erased member's
    // uploaded objects from bucket storage (see AccountDeletionProcessorService).
    StorageModule,
    // `CommunityOwnerOrphanService.handleOwnerErasure` — called from
    // `AccountDeletionProcessorService.eraseAccount` right before the `User`
    // row is hard-deleted, so an erased owner's communities get a new owner
    // (or get flagged for review) while `communities.owner_id` still points
    // at them. Plain import, no `forwardRef`: `CommunitiesModule` does not
    // import `AccountModule`, directly or transitively.
    CommunitiesModule,
    // `UsersModule` exports `UsersService`, injected for the shared
    // `countAdmins` last-admin guard `deactivate`/`requestDeletion` use
    // (`assertNotSoleAdmin`) — the same helper `AdminMembersService.updateRole`
    // uses against role-demotion.
    UsersModule,
    // `MyCardsService` — `MembershipCardsExportContributor`
    // (data-export-contributors.ts) delegates the `membershipCards` Art. 20
    // category to `forUser(userId)` rather than re-querying the cards tables
    // directly. Plain import, no `forwardRef`: `MembershipCardsModule` does
    // not import `AccountModule`, directly or transitively.
    MembershipCardsModule,
    // `NotificationsService`: `ContentOwnerErasureService` fans an existing
    // `EventCancelled` notification out to everyone holding an RSVP when an
    // erased member's gathering has no co-host to inherit it. Plain import, no
    // `forwardRef`: `NotificationsModule` does not import `AccountModule`,
    // directly or transitively.
    NotificationsModule,
    // `MediaReferenceResolver`: the erasure sweep's storage step asks it
    // whether anything still points at each of the erased member's uploaded
    // objects, and deletes only the ones nothing does. Without that check the
    // sweep deleted by key prefix alone, which destroyed media that surviving
    // rows still referenced (a gathering photo, whose `uploader_id` is
    // `ON DELETE SET NULL`, being the case that surfaced it). Plain import, no
    // `forwardRef`: `MediaReferencesModule` does not import `AccountModule`,
    // directly or transitively.
    MediaReferencesModule,
    // `IdentitiesService`: Task 13f's export fix renders a business mailbox
    // thread's counterpart and sender as the business itself. Plain import,
    // no `forwardRef`: `IdentitiesModule` registers only its own entities and
    // imports no other module, so it cannot cycle back to `AccountModule`.
    IdentitiesModule,
    // `SubprofileMembershipService.handOverCreatedPersonasFor`: called from
    // `AccountDeletionProcessorService.eraseAccount` before the `User` row is
    // hard-deleted, so every shared persona the erased member created passes
    // to its longest-standing remaining co-owner instead of cascading away
    // with `subprofiles.user_id`. Plain import, no `forwardRef`: only
    // `AppModule` imports `AccountModule`, so `SubprofilesModule` cannot reach
    // it, directly or transitively.
    SubprofilesModule,
    AdminQueueNotificationsModule,
    TypeOrmModule.forFeature([
      DeletionRequest,
      DsarRequest,
      DataExportJob,
      AccountReauthToken,
      AccountDeactivation,
      // Reuses the existing refresh-token store (owned by `src/auth`) for
      // session listing/revocation — registered here (not exported by
      // `AuthModule`) rather than re-implemented. See the module's own
      // `TypeOrmModule.forFeature` registration in `src/auth/auth.module.ts`;
      // TypeORM permits the same entity's repository being registered in
      // more than one module.
      RefreshToken,
      // The suppression list survives account erasure and has no FK to
      // `users` — see the entity for why.
      EmailSuppression,
      // Read-only sources for the Art. 20 archive (`AccountExportService`) and,
      // for `User`, the row the erasure sweep deletes. Registered the same way
      // `RefreshToken` is above: the owning module keeps its own
      // `forFeature`, and TypeORM allows the same entity in more than one.
      User,
      Profile,
      Message,
      ForumThread,
      ForumPost,
      Event,
      EventRsvp,
      // Write-side sources for `ContentOwnerErasureService`: the erased
      // member's future gatherings are handed to a co-host (`EventCohost`) or
      // cancelled, and a series they were running follows its occurrences
      // (`EventSeries`). Same cross-module registration pattern as the
      // entities above.
      EventCohost,
      EventSeries,
      // Pending invitations to a cancelled gathering. A standing invite is a
      // decision the platform asked somebody to make, so its withdrawal is
      // owed to them exactly as much as it is to somebody who already said
      // yes — see `ContentOwnerErasureService.notifyAttendeesCancelled`.
      EventInvite,
      // Open postings the erased member left behind, closed by
      // `ContentOwnerErasureService` so nobody applies into a void.
      Job,
      VolunteerOpportunity,
      Connection,
      Vouch,
      Activity,
      // Read-only sources for the newer-domain export contributors
      // (see data-export-contributors.ts). Same cross-module registration
      // pattern as the entities above — the owning module keeps its own
      // forFeature, and TypeORM allows the same entity in more than one.
      Subprofile,
      Listing,
      HousingListing,
      SavedItem,
      Notification,
      ConsentRecord,
      // Read-only sources for the Art. 20 domains the archive used to miss
      // entirely (ID-12): the member's magazine writing, the communities they
      // own and everything they posted in one, their volunteering signups,
      // their governance votes and proposals, and the reviews they wrote.
      // Registered the same cross-module way as everything above — the owning
      // module keeps its own `forFeature`, and TypeORM allows the same entity
      // in more than one. The `media` category needs no entity at all: it
      // reads the bucket through `StorageService` (already imported above for
      // the erasure sweep).
      MagazineAuthor,
      MagazineArticle,
      MagazineStorySubmission,
      MagazinePiece,
      Community,
      CommunityPost,
      CommunityPostReply,
      VolunteerSignup,
      GovernanceVote,
      GovernanceProposal,
      ListingReview,
      CompanyReview,
      HousingReview,
      // Read-only source for `ProfileNowHistoryExportContributor`'s
      // `nowHistory` category: the profile "Now" card's retired statuses,
      // owned by `ProfilesModule`'s own `forFeature`. Same cross-module
      // registration pattern as every entity above.
      ProfileNowHistory,
      // Read-only sources for `GoTogetherExportContributor`'s `goTogether`
      // category: the member's Go together questionnaire, their opt-ins into
      // gatherings, the "meet again" verdicts they gave, their answers about
      // each group, and their private avoidances. Same cross-module
      // registration pattern as every entity above: the owning module keeps
      // its own `forFeature`, and TypeORM allows the same entity in more than
      // one.
      FriendMatchProfile,
      EventMatchEntry,
      MatchFeedback,
      MatchGroupFeedback,
      MatchAvoidance,
      // ENG-495: read-only sources for the contributors in
      // data-export-contributors-safety.ts: the member's flatmate profile,
      // housing viewings and group/co-op join requests (`housing`), the blocks
      // they placed (`connections`), the reports they filed (`reports`) and
      // their policy acceptances (`consent`). Same cross-module registration
      // pattern as every entity above.
      FlatmateProfile,
      HousingViewing,
      GroupJoinRequest,
      CoopJoinRequest,
      Block,
      IdentityBlock,
      Report,
      PolicyAcceptance,
      // ENG-495 fix round 1: read-only sources for the contributors in
      // data-export-contributors-account.ts (push devices, notification
      // settings, mutes, hidden members, flatmate likes, housing saved
      // searches). `sessions` reads `RefreshToken`, registered above.
      PushSubscription,
      NotificationPreference,
      NotificationDeliveryPreference,
      Mute,
      HiddenFromMember,
      FlatmateLike,
      HousingSavedSearch,
      // ENG-495b: read-only sources for the entity-audit contributors in
      // data-export-contributors-more.ts.
      // Fix round 1: forum polls, verification level changes, the join
      // application, staff roles, magazine payments and persona content.
      ForumPollOption,
      ForumPoll,
      VerificationEvent,
      PlatformJoinRequest,
      UserStaffRole,
      MagazinePayment,
      SubprofileItem,
      SubprofileSocialLink,
      SubprofileAffiliation,
      Affiliation,
      Ambassador,
      BarterListing,
      BarterProposal,
      ChangemakerNomination,
      WatchProgress,
      CollectionItem,
      Collection,
      CommunityInvite,
      CommunityJoinRequest,
      CommunityMember,
      CommunityOwnerReviewRequest,
      CommunityPostEdit,
      CommunityPostReaction,
      CommunityPostReplyEdit,
      CommunityResource,
      CommunitySpaceRequest,
      CommunityTagRequest,
      CompanyTeamMember,
      Company,
      ConnectionNote,
      CommissionInterest,
      Draft,
      EventAnnouncement,
      EventBookmark,
      EventCohostInvite,
      EventLineupEntry,
      EventPhoto,
      MemberEventReminderPreferences,
      FeedSourceMute,
      ForumPollVote,
      ForumPostEdit,
      ForumPostVote,
      ForumThreadSubscription,
      GovernanceProposalCosignature,
      HandleHistory,
      Handle,
      GroupListing,
      IdentityStaffPreference,
      IntakeSubmission,
      JobApplication,
      LandlordIntroRequest,
      LandlordRecommendation,
      Landlord,
      ListingDraft,
      ListingClaim,
      ListingCoManager,
      ListingEditSuggestion,
      ListingEnquiry,
      ListingOwnerOffer,
      ListingPublicQuestion,
      ListingReviewHelpfulVote,
      MagazineArticleComment,
      MagazinePieceMessage,
      MagazinePitch,
      MagazineReaderComment,
      MagazineWriterApplication,
      MediaCrop,
      MemberSuggestionDismissal,
      MembershipCardScan,
      MembershipCard,
      Invite,
      GroupInvite,
      MessageHide,
      MessageReaction,
      MessageStar,
      Appeal,
      Partner,
      MemberPreferences,
      BoardPostResponse,
      BoardPost,
      GroupMembership,
      ProfileFeaturedCommunity,
      ProfileLastActive,
      Shaping,
      Skill,
      SocialLink,
      WorkItem,
      ReadingGroupProposal,
      RecognitionAward,
      RecognitionLedgerEntry,
      RecognitionPerkClaim,
      ResourceGuideRating,
      ResourceSuggestion,
      RoadmapIdea,
      RoadmapItemComment,
      RoadmapVote,
      SafeSpaceFlag,
      SafeSpaceNomination,
      SafeSpaceMemberVouch,
      SavedListEntry,
      SavedList,
      SubprofileEndorsement,
      SubprofileFollower,
      SubprofileInvite,
      SubprofileMember,
      TopicFollow,
      VerificationRequest,
      MemberVerification,
      VolunteerOpportunityTeam,
    ]),
  ],
  controllers: [AccountController],
  providers: [
    AccountService,
    AccountDependenciesService,
    AccountExportService,
    // Cron-only; nothing injects it. Registering it here is what starts the
    // daily erasure sweep.
    AccountDeletionProcessorService,
    // Injected by the erasure sweep above: hands an erased member's future
    // gatherings to a co-host or cancels them, and closes the postings they
    // left open. See its own docstring for the ordering rule.
    ContentOwnerErasureService,
    // Cron-only; registering it starts the data-export-archive and reauth-token
    // retention sweeps.
    AccountRetentionService,
    // Cron-only; registering it starts the daily release of messages an
    // erasure held for an open report (ENG-243).
    ErasedSenderMessageReleaseService,
    // The newer-domain export contributors + the registry token that collects
    // them. Adding a domain to the Art. 20 archive is exactly: implement a
    // DataExportContribution and add it here.
    ...NEW_DOMAIN_EXPORT_CONTRIBUTORS,
    {
      provide: DATA_EXPORT_CONTRIBUTORS,
      useFactory: (
        ...contributors: DataExportContribution[]
      ): DataExportContribution[] => contributors,
      inject: [...NEW_DOMAIN_EXPORT_CONTRIBUTORS],
    },
  ],
  exports: [AccountService],
})
export class AccountModule {}
