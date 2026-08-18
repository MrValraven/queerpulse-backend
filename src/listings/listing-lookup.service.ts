import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Listing, ListingStatus } from './entities/listing.entity';

export interface ListingRef {
  slug: string;
  name: string;
}

/**
 * Shared "resolve a listing id to its public slug/name" step, reused by
 * feature modules (events, ...) that need to validate/display a
 * `listingId` FK without importing the whole `ListingsModule` — mirrors
 * `CommunityMembershipService.slugById`'s role for `communitySlug`.
 *
 * Only a `Live` listing resolves: a listing still in `review`/`question` has
 * no public page, so it isn't a valid link target and reads as not-found.
 */
@Injectable()
export class ListingLookupService {
  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
  ) {}

  async findLive(listingId: string): Promise<ListingRef | null> {
    const listing = await this.listings.findOne({
      where: { id: listingId, status: ListingStatus.Live },
    });
    return listing ? { slug: listing.slug, name: listing.name } : null;
  }
}
