import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Not, Repository } from 'typeorm';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';

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

  /**
   * Resolve a listing for DISPLAY alongside something that already links to
   * it. A permanently closed business still resolves here on purpose: an event
   * that happened at a venue happened there whether or not the venue has since
   * shut, and blanking the name would erase that rather than correct it. The
   * same holds for a listing its owner has paused: the gathering was at that
   * venue, and the pause is about the directory entry rather than about the
   * event's history. Only the venue's NAME is surfaced from here, never a
   * browsable listing. Use `findLinkable` for the create/update path, where a
   * closed or paused venue is a real error.
   */
  async findLive(listingId: string): Promise<ListingRef | null> {
    const listing = await this.listings.findOne({
      where: { id: listingId, status: ListingStatus.Live },
    });
    return listing ? { slug: listing.slug, name: listing.name } : null;
  }

  /**
   * Resolve a listing that is valid as a NEW link target: live, still
   * operating, and still shown in the directory. A permanently closed business
   * is deliberately unlinkable, so nothing can schedule a gathering at a venue
   * that has shut. The other operating states stay linkable: a temporarily
   * closed venue reopens, and a moved one is still the same business at a new
   * address.
   *
   * A listing its owner has PAUSED is likewise unlinkable, for a different
   * reason: its public page 404s, so a new link pointing at it would be broken
   * the moment it was made. Existing links are unaffected, because they resolve
   * through `findLive` above.
   */
  async findLinkable(listingId: string): Promise<ListingRef | null> {
    const listing = await this.listings.findOne({
      where: {
        id: listingId,
        status: ListingStatus.Live,
        operatingState: Not(ListingOperatingState.PermanentlyClosed),
        isHiddenByOwner: false,
      },
    });
    return listing ? { slug: listing.slug, name: listing.name } : null;
  }
}
