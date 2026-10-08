import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ContentModerationModule } from '../content-moderation/content-moderation.module';
import { ListingLookupService } from './listing-lookup.service';
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
 */
@Module({
  imports: [TypeOrmModule.forFeature([Listing]), ContentModerationModule],
  providers: [ListingLookupService],
  exports: [ListingLookupService],
})
export class ListingLookupModule {}
