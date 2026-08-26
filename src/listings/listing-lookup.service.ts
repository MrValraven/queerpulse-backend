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
 * What the ATTACH path needs on top of the display ref (LOC-16): the listing's
 * own id, and the member who owns it, so a gathering that has just linked
 * itself to a business can ask that business's owner whether they agree.
 *
 * Deliberately a SEPARATE interface rather than extra keys on `ListingRef`.
 * `ListingRef` is spread straight into `EventDetail.venueListing`, which is a
 * public response, so widening it would have published a listing's internal id
 * and its owner's user id on every gathering page.
 *
 * `ownerId` is null for a listing nobody has claimed yet. See
 * `EventsService.notifyVenueOwnerBestEffort` for what happens then (nothing:
 * there is no one to ask, so the attachment simply stays pending).
 */
export interface AttachableListingRef extends ListingRef {
  id: string;
  ownerId: string | null;
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
    const listing = await this.findAttachable(listingId);
    return listing ? { slug: listing.slug, name: listing.name } : null;
  }

  /**
   * The same "valid as a NEW link target" test as `findLinkable`, returning
   * the listing's id and owner alongside its display ref so the caller can ask
   * the owner for consent (LOC-16).
   *
   * `findLinkable` now delegates here, so the two can never drift into
   * disagreeing about what is linkable, which is the one way this pair could
   * go wrong: an event attaching through a laxer predicate than the one that
   * decides whether the venue page will ever show it.
   */
  async findAttachable(
    listingId: string,
  ): Promise<AttachableListingRef | null> {
    const listing = await this.listings.findOne({
      where: {
        id: listingId,
        status: ListingStatus.Live,
        operatingState: Not(ListingOperatingState.PermanentlyClosed),
        isHiddenByOwner: false,
      },
    });
    return listing
      ? {
          id: listing.id,
          slug: listing.slug,
          name: listing.name,
          ownerId: listing.ownerId,
        }
      : null;
  }
}
