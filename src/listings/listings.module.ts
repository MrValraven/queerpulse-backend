import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { UserStaffRole } from '../users/entities/user-staff-role.entity';
import { AdminQueueNotificationsModule } from '../admin-queue-notifications/admin-queue-notifications.module';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { Event } from '../events/entities/event.entity';
import { IdentitiesModule } from '../identities/identities.module';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageModule } from '../storage/storage.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { UsersModule } from '../users/users.module';
import { AdminListingsController } from './admin-listings.controller';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';
import { ListingClaim } from './entities/listing-claim.entity';
import { ListingCoManager } from './entities/listing-co-manager.entity';
import { ListingEditSuggestion } from './entities/listing-edit-suggestion.entity';
import { ListingEnquiry } from './entities/listing-enquiry.entity';
import { ListingModerationEvent } from './entities/listing-moderation-event.entity';
import { ListingOwnerOffer } from './entities/listing-owner-offer.entity';
import { ListingPublicQuestion } from './entities/listing-public-question.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReviewHelpfulVote } from './entities/listing-review-helpful-vote.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing } from './entities/listing.entity';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { ReportsModule } from '../reports/reports.module';
import { SafeSpaceVouchesModule } from '../safe-space-vouches/safe-space-vouches.module';
import { SafeSpaceNominationsModule } from '../safe-space-nominations/safe-space-nominations.module';
import { ListingClaimsService } from './listing-claims.service';
import { ListingCoManagersController } from './listing-co-managers.controller';
import { ListingCoManagersService } from './listing-co-managers.service';
import { ListingEnquiriesController } from './listing-enquiries.controller';
import { ListingEnquiriesService } from './listing-enquiries.service';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
import { ListingOwnerOffersService } from './listing-owner-offers.service';
import { ListingOwnerPendingService } from './listing-owner-pending.service';
import { ListingOwnershipService } from './listing-ownership.service';
import { ListingVenueEventsService } from './listing-venue-events.service';
import { ListingsController } from './listings.controller';
import { ListingsService } from './listings.service';

@Module({
  imports: [
    // `Event` is registered here only to read a listing's upcoming events in
    // `DirectoryService`; the events domain itself lives in `EventsModule`.
    // `SavedItem` is registered here only for the read-only `savedCount`
    // aggregate on the directory detail DTO — the saved-items domain itself
    // lives in `SavedModule`.
    TypeOrmModule.forFeature([
      // Read-only, and only for `RolesOrStaffGuard` on this module's admin
      // controllers: it resolves the caller's additive staff grants when their
      // account tier alone does not satisfy `@Roles(...)`. Same registration
      // precedent as `HousingListingsModule` for `HousingModerationGuard`.
      UserStaffRole,

      Listing,
      ListingReview,
      // Real "was this helpful" votes on a review — the rows
      // `listing_reviews.helpful` now counts.
      ListingReviewHelpfulVote,
      // The PUBLIC "ask the owner" Q&A on a listing detail page. NOT
      // `ListingQuestion` below, which is the moderator-to-submitter channel
      // used during review; see both entities' doc comments.
      ListingPublicQuestion,
      ListingEditSuggestion,
      // Moderation audit trail (#16) + Q&A thread (#17) — the admin
      // console overhaul's `ListingModerationEvent`/`ListingQuestion`.
      ListingModerationEvent,
      ListingQuestion,
      // "Claim this existing listing" (member requests, moderator reviews) —
      // its own entity/service, same reason `ListingEditSuggestion` is.
      ListingClaim,
      // Co-manager seats: who besides the single `owner_id` may run this
      // listing day to day. Invited and accepted, never direct-added, and never
      // present in any public response.
      ListingCoManager,
      // An admin nominating a member as the owner of a listing that has
      // none. Sits at `offered` until the member answers; an accept then
      // calls the same ownership-transfer path a claim uses.
      ListingOwnerOffer,
      // "Message this business" — the link between a listing and the 1:1
      // conversation an enquiry was delivered into. Holds NO message text;
      // messaging still owns message storage (see the entity's docstring).
      ListingEnquiry,
      Event,
      SavedItem,
      // Read-only here: `DirectoryService` merges member-written safe-space
      // vouches into the safe-space detail DTO. Writes live in
      // `SafeSpaceVouchesModule`.
      SafeSpaceMemberVouch,
    ]),
    UsersModule,
    // `IdentitiesService`/`IdentityMailboxSyncService`, used by
    // `ListingCoManagersService` and `ListingOwnershipService` to resolve a
    // listing's mailbox identity and keep its `conversation_participants`
    // seats in step with the staff list. Plain import, no `forwardRef`:
    // `IdentitiesModule` registers `Listing`/`ListingCoManager` as entities
    // only and imports no module of this domain, so this edge is
    // one-directional.
    IdentitiesModule,
    // MessagingModule exports MessagingService — delivers a moderator's
    // question to the submitter as a DM (mirrors HousingListingsModule).
    MessagingModule,
    // `ContentModerationService` — public directory/safe-space reads honour a
    // moderator `hide_content`/`remove_content` takedown on a business listing.
    ContentModerationModule,
    // `NotificationsService` — listing approved (submitter, in `ListingsService`),
    // a new review (owner, in `DirectoryService`), a new public question
    // (owner, in `DirectoryService`), an answered public question (asker, in
    // `ListingsService`), and a reviewed claim (claimant, in
    // `ListingClaimsService`).
    NotificationsModule,
    // `StorageService` — delete a listing's photo objects when they are replaced
    // on edit or when the listing itself is removed, so superseded/orphaned
    // gallery uploads stop living in the bucket forever. `DirectoryService`
    // uses it for the same reason on a review photo replaced by its author.
    StorageModule,
    // `ReportsService` — a listing dispute/claim and the owner-notify task on
    // creation are filed through the shared report+moderation pipeline (item
    // #13). `ReportsModule` imports only `TypeOrmModule`, so no cycle.
    ReportsModule,
    // Batched crop lookup (`MediaCropService.getMany`) for `photos`'s
    // per-slot `photoCrops` sibling, shared by `ListingsService` and
    // `DirectoryService`.
    MediaCropsModule,
    // `SafeSpaceBadgeService` — every public read that serialises a safe-space
    // badge asks it whether that badge is currently SUSPENDED, so a space three
    // members flagged can never render as verified on a card, in the
    // safe-spaces list, or in its hero counts.
    //
    // The dependency runs THIS way only. `SafeSpaceNominationsModule`
    // deliberately does not import this module (it registers the `Listing`
    // entity alone, for the reason its own docstring gives), and its own
    // imports are `NotificationsModule` + `SafeSpaceVouchesModule`, neither of
    // which reaches back here. So this is a plain import with no cycle and no
    // `forwardRef`.
    SafeSpaceNominationsModule,
    // `SafeSpaceVisitsService`, so `ListingsService.setSafeSpace` can enforce
    // the published three-independent-visit bar before a listing becomes
    // `verified`. Imported directly rather than leant on through
    // `SafeSpaceNominationsModule` above, which imports it but does not
    // re-export it. The comment on that import already establishes the
    // direction: `SafeSpaceVouchesModule` registers `Listing` and
    // `ListingCoManager` as ENTITIES only and imports no module of this
    // domain, so this is a plain import with no cycle and no `forwardRef`.
    SafeSpaceVouchesModule,
    // `ReviewReplyNotifier` (PRD-47/48) — the review's author is told when the
    // business answers it, in `ListingsService.replyToReview`. Before this the
    // directory was the only one of the three review verticals that answered a
    // member in silence.
    //
    // A plain import with no `forwardRef`: `SubmissionsModule` has no
    // controller and no entity, and imports `NotificationsModule` alone, which
    // never reaches back here.
    SubmissionsModule,
    // Tells whoever works the listing-submission, listing-claim and
    // edit-suggestion queues when a member's own action lands a new row.
    // Shared by `ListingsService`, `ListingClaimsService` and
    // `ListingEditSuggestionsService`, all providers of this module.
    AdminQueueNotificationsModule,
  ],
  controllers: [
    // FIRST, and that is load-bearing rather than stylistic. Nest resolves
    // handlers in this array's order, and `ListingsController` declares
    // `@Get(':ref')` on the same `listings` base path, so the literal
    // `listings/co-manager-invites` routes have to be registered ahead of it.
    // Move this line down and every invite route silently becomes a lookup for
    // a listing whose ref is "co-manager-invites".
    ListingCoManagersController,
    ListingsController,
    // Every moderator/admin route over listings, split out so the whole class
    // shares one `ActiveMemberGuard + RolesGuard` pair (BE-HSG-29).
    AdminListingsController,
    DirectoryController,
    // Signed-in "message this business" routes, kept off `DirectoryController`
    // so that class stays entirely public + CDN-cacheable — see the
    // controller's own docstring.
    ListingEnquiriesController,
  ],
  providers: [
    ListingsService,
    // The second management gate's data source. Injected by `ListingsService`,
    // `ListingOwnerPendingService`, `ListingClaimsService` and
    // `ListingOwnershipService`; injects none of them back, so there is no
    // cycle and no `forwardRef`. Two controllers of this module take it
    // directly: `ListingCoManagersController` for the owner and member seat
    // routes, and `AdminListingsController` for the admin-only `staff*`
    // delegation ones.
    ListingCoManagersService,
    ListingEditSuggestionsService,
    // The one place a listing changes hands. `ListingClaimsService` calls it
    // on an approved claim and the staff owner-offer path calls it on an
    // accept, so the personal-field clearing, the co-manager revocation and
    // the `ownership_transferred` audit row stay identical on both routes.
    // Injects `ListingCoManagersService` above; nothing injects it back, so
    // there is no cycle and no `forwardRef`.
    ListingOwnershipService,
    ListingClaimsService,
    // Task 4: the staff owner-offer lifecycle. Injects `ListingOwnershipService`
    // above for the one ownership write an accept performs; nothing injects it
    // back, so there is no cycle and no `forwardRef`.
    ListingOwnerOffersService,
    ListingEnquiriesService,
    // C8: the owner-facing "what is pending on my listing?" read. Its
    // `Repository<Report>` comes from `ReportsModule`'s re-exported
    // `TypeOrmModule`, already imported above.
    ListingOwnerPendingService,
    // LOC-16: the venue owner's side of an event-to-listing attachment
    // (confirm / detach). Reads and writes `events` through the `Event`
    // repository already registered above for `DirectoryService`, and reads
    // `Profile` through `UsersModule`'s re-exported `TypeOrmModule`.
    ListingVenueEventsService,
    DirectoryService,
  ],
  exports: [
    DirectoryService,
    // Exported so the staff owner-offer flow can accept an offer through the
    // same transfer a claim approval uses, from a service outside this module.
    ListingOwnershipService,
    // The admin console and the member's own "you have been offered a
    // listing" surface both live outside this module and call it.
    ListingOwnerOffersService,
  ],
})
export class ListingsModule {}
