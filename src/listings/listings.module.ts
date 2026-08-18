import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { Event } from '../events/entities/event.entity';
import { MediaCropsModule } from '../media-crops/media-crops.module';
import { MessagingModule } from '../messaging/messaging.module';
import { NotificationsModule } from '../notifications/notifications.module';
import { SavedItem } from '../saved/entities/saved-item.entity';
import { StorageModule } from '../storage/storage.module';
import { UsersModule } from '../users/users.module';
import { DirectoryController } from './directory.controller';
import { DirectoryService } from './directory.service';
import { ListingClaim } from './entities/listing-claim.entity';
import { ListingEditSuggestion } from './entities/listing-edit-suggestion.entity';
import { ListingModerationEvent } from './entities/listing-moderation-event.entity';
import { ListingQuestion } from './entities/listing-question.entity';
import { ListingReview } from './entities/listing-review.entity';
import { Listing } from './entities/listing.entity';
import { SafeSpaceMemberVouch } from '../safe-space-vouches/entities/safe-space-vouch.entity';
import { ReportsModule } from '../reports/reports.module';
import { ListingClaimsService } from './listing-claims.service';
import { ListingEditSuggestionsService } from './listing-edit-suggestions.service';
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
      Listing,
      ListingReview,
      ListingEditSuggestion,
      // Moderation audit trail (#16) + Q&A thread (#17) — the admin
      // console overhaul's `ListingModerationEvent`/`ListingQuestion`.
      ListingModerationEvent,
      ListingQuestion,
      // "Claim this existing listing" (member requests, moderator reviews) —
      // its own entity/service, same reason `ListingEditSuggestion` is.
      ListingClaim,
      Event,
      SavedItem,
      // Read-only here: `DirectoryService` merges member-written safe-space
      // vouches into the safe-space detail DTO. Writes live in
      // `SafeSpaceVouchesModule`.
      SafeSpaceMemberVouch,
    ]),
    UsersModule,
    // MessagingModule exports MessagingService — delivers a moderator's
    // question to the submitter as a DM (mirrors HousingListingsModule).
    MessagingModule,
    // `ContentModerationService` — public directory/safe-space reads honour a
    // moderator `hide_content`/`remove_content` takedown on a business listing.
    ContentModerationModule,
    // `NotificationsService` — listing approved (submitter, in `ListingsService`),
    // a new review (owner, in `DirectoryService`), and a reviewed claim
    // (claimant, in `ListingClaimsService`).
    NotificationsModule,
    // `StorageService` — delete a listing's photo objects when they are replaced
    // on edit or when the listing itself is removed, so superseded/orphaned
    // gallery uploads stop living in the bucket forever.
    StorageModule,
    // `ReportsService` — a listing dispute/claim and the owner-notify task on
    // creation are filed through the shared report+moderation pipeline (item
    // #13). `ReportsModule` imports only `TypeOrmModule`, so no cycle.
    ReportsModule,
    // Batched crop lookup (`MediaCropService.getMany`) for `photos`'s
    // per-slot `photoCrops` sibling, shared by `ListingsService` and
    // `DirectoryService`.
    MediaCropsModule,
  ],
  controllers: [ListingsController, DirectoryController],
  providers: [
    ListingsService,
    ListingEditSuggestionsService,
    ListingClaimsService,
    DirectoryService,
  ],
  exports: [DirectoryService],
})
export class ListingsModule {}
