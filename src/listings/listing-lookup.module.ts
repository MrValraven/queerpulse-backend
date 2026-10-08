import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { ListingLookupService } from './listing-lookup.service';
import { ListingRunByService } from './listing-run-by.service';
import { ListingCoManager } from './entities/listing-co-manager.entity';
import { Listing } from './entities/listing.entity';

/**
 * Read-only `forFeature` registration for `ListingLookupService`. Deliberately
 * does NOT import `ListingsModule` (heavy: pulls in users, messaging, content
 * moderation, notifications, storage, reports, media-crops) — feature modules
 * (events, ...) that only need "resolve a listing id to its public
 * slug/name" should import THIS module instead, mirroring
 * `CommunityMembershipModule`'s role for community slugs.
 *
 * `ContentModerationModule` is the one import beyond the repository, and it is
 * light (one `forFeature`, no further imports): `findLive` reads it so a venue
 * pin a moderator has taken down stays off every gathering page too.
 *
 * `ListingRunByService` rides here as well, for a gathering's "Run by" line:
 * it reads `listing_co_managers` through this module's own read-only
 * `forFeature`, so the events domain never imports `ListingsModule`.
 */
@Module({
  imports: [
    TypeOrmModule.forFeature([Listing, ListingCoManager]),
    ContentModerationModule,
  ],
  providers: [ListingLookupService, ListingRunByService],
  exports: [ListingLookupService, ListingRunByService],
})
export class ListingLookupModule {}
