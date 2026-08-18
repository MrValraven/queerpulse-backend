import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ListingLookupService } from './listing-lookup.service';
import { Listing } from './entities/listing.entity';

/**
 * Read-only `forFeature` registration for `ListingLookupService`. Deliberately
 * does NOT import `ListingsModule` (heavy: pulls in users, messaging, content
 * moderation, notifications, storage, reports, media-crops) — feature modules
 * (events, ...) that only need "resolve a listing id to its public
 * slug/name" should import THIS module instead, mirroring
 * `CommunityMembershipModule`'s role for community slugs.
 */
@Module({
  imports: [TypeOrmModule.forFeature([Listing])],
  providers: [ListingLookupService],
  exports: [ListingLookupService],
})
export class ListingLookupModule {}
