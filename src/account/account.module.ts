import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { RefreshToken } from '../auth/entities/refresh-token.entity';
import { CompanyReview } from '../companies/entities/company-review.entity';
import { CommunitiesModule } from '../communities/communities.module';
import { CommunityPostReply } from '../communities/entities/community-post-reply.entity';
import { CommunityPost } from '../communities/entities/community-post.entity';
import { Community } from '../communities/entities/community.entity';
import { Connection } from '../connections/entities/connection.entity';
import { ConsentRecord } from '../consent/entities/consent-record.entity';
import { EventCohost } from '../events/entities/event-cohost.entity';
import { EventRsvp } from '../events/entities/event-rsvp.entity';
import { EventSeries } from '../events/entities/event-series.entity';
import { Event } from '../events/entities/event.entity';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { GovernanceProposal } from '../governance/entities/governance-proposal.entity';
import { GovernanceVote } from '../governance/entities/governance-vote.entity';
import { HousingListing } from '../housing-listings/entities/housing-listing.entity';
import { HousingReview } from '../housing-reviews/entities/housing-review.entity';
import { Job } from '../jobs/entities/job.entity';
import { ListingReview } from '../listings/entities/listing-review.entity';
import { Listing } from '../listings/entities/listing.entity';
import { MagazineArticle } from '../magazine/entities/magazine-article.entity';
import { MagazineAuthor } from '../magazine/entities/magazine-author.entity';
import { MagazinePiece } from '../magazine/entities/magazine-piece.entity';
import { MagazineStorySubmission } from '../magazine/entities/magazine-story-submission.entity';
import { MembershipCardsModule } from '../membership-cards/membership-cards.module';
import { Message } from '../messaging/entities/message.entity';
import { Notification } from '../notifications/entities/notification.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { Activity } from '../profiles/entities/activity.entity';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageModule } from '../storage/storage.module';
import { Subprofile } from '../subprofiles/entities/subprofile.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { UsersModule } from '../users/users.module';
import { VolunteerOpportunity } from '../volunteering/entities/volunteer-opportunity.entity';
import { VolunteerSignup } from '../volunteering/entities/volunteer-signup.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AccountDeletionProcessorService } from './account-deletion-processor.service';
import { AccountExportService } from './account-export.service';
import { AccountRetentionService } from './account-retention.service';
import { AccountController } from './account.controller';
import { AccountService } from './account.service';
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
import { EmailPreference } from './entities/email-preference.entity';

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
    TypeOrmModule.forFeature([
      DeletionRequest,
      DsarRequest,
      DataExportJob,
      EmailPreference,
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
    ]),
  ],
  controllers: [AccountController],
  providers: [
    AccountService,
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
