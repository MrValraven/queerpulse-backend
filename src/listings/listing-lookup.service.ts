import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ArrayContains, Not, Repository } from 'typeorm';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';
import { ADULT_LISTING_CATEGORY_SLUG } from './listing-categories';

export interface ListingRef {
  slug: string;
  name: string;
}

/**
 * What the DISPLAY path (`findLive`) returns on top of the display ref: the
 * listing's own map pin and street address, so a gathering's page can draw its
 * venue on a map and say where it is (`EventDetail.venueListing`). The pin is
 * in decimal degrees, read straight off the `double precision` columns, which
 * the pg driver already hands back as JS numbers, so no conversion is needed
 * (`toDirectoryCard` reads them the same way). The address is the listing's
 * own `address` column, trimmed.
 *
 * Both follow the listing's own public page exactly. `toDirectoryCard` prints
 * the stored pair, and `toDirectoryDetail` the stored address, with no
 * condition of their own, so the rule is decided by whether that page renders
 * at all. The pin values are null whenever the page would not show the pin:
 *  - the owner has paused the listing (`isHiddenByOwner`): its page 404s;
 *  - a moderator has hidden or removed it: its page 404s;
 *  - it is online-only: it has no premises, its card never pins the map, and
 *    the write path already blanks its coordinates;
 *  - the owner never placed a pin (or only half of one).
 * The address is null under the same first three conditions, and when the
 * owner never typed one (blank after trimming).
 * A permanently closed business keeps its pin and its address, because its
 * page stays up so its reviews and history stay where every link points. An
 * 18+ listing keeps them too: its page is readable by any signed-in active
 * member, and every reader of a gathering is one (`ActiveMemberGuard` on
 * `EventsController`).
 *
 * The address here is the BUSINESS's public directory address. It has nothing
 * to do with the gathering's own host-typed `EventDetail.address`, which stays
 * attendee-only: this one reveals only what the listing's page already shows
 * every member.
 *
 * Kept OFF `ListingRef` on purpose. `findLinkable` and `findAttachable` share
 * that ref for the create/update path, which never draws a map and skips the
 * takedown check above, so a pin or an address there would be an ungated copy
 * waiting for a caller to publish it.
 */
export interface VenueListingRef extends ListingRef {
  latitude: number | null;
  longitude: number | null;
  address: string | null;
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
  // A directory business is reported (and taken down) under either the
  // `business` or the `listing` code, both keyed by the listing slug. The same
  // pair `DirectoryService.SUBJECT_TYPES` checks before it renders the page.
  private static readonly MODERATION_SUBJECT_TYPES = ['business', 'listing'];

  constructor(
    @InjectRepository(Listing) private readonly listings: Repository<Listing>,
    private readonly contentModeration: ContentModerationService,
  ) {}

  /**
   * Resolve a listing for DISPLAY alongside something that already links to
   * it. A permanently closed business still resolves here on purpose: an event
   * that happened at a venue happened there whether or not the venue has since
   * shut, and blanking the name would erase that rather than correct it. The
   * same holds for a listing its owner has paused: the gathering was at that
   * venue, and the pause is about the directory entry rather than about the
   * event's history. Only the venue's NAME and, where its own public page
   * shows them, its map pin and street address are surfaced from here, never
   * a browsable listing (see `VenueListingRef` for the rule). Use
   * `findLinkable` for the create/update path, where a closed or paused venue
   * is a real error.
   *
   * The cheap column checks run first, so the moderation read happens at most
   * once, and only for a listing that has a pin or an address to withhold.
   */
  async findLive(listingId: string): Promise<VenueListingRef | null> {
    const listing = await this.listings.findOne({
      where: { id: listingId, status: ListingStatus.Live },
    });
    if (!listing) return null;
    // An online-only listing has no premises, so its page shows neither.
    const isPlace = !listing.online;
    const hasPin =
      isPlace &&
      typeof listing.latitude === 'number' &&
      typeof listing.longitude === 'number';
    const trimmedAddress = isPlace ? listing.address.trim() : '';
    const hasAddress = trimmedAddress.length > 0;
    const isPublicPageRendered =
      (hasPin || hasAddress) && (await this.isPublicPageRendered(listing));
    const isPinShown = hasPin && isPublicPageRendered;
    const isAddressShown = hasAddress && isPublicPageRendered;
    return {
      slug: listing.slug,
      name: listing.name,
      latitude: isPinShown ? listing.latitude : null,
      longitude: isPinShown ? listing.longitude : null,
      address: isAddressShown ? trimmedAddress : null,
    };
  }

  /**
   * Whether the listing's own public directory page renders at all, by the
   * rule `VenueListingRef` spells out: its owner has not paused it, and no
   * moderator has hidden or removed it. The owner check runs first, so the
   * moderation read is skipped for a paused listing.
   */
  private async isPublicPageRendered(listing: Listing): Promise<boolean> {
    if (listing.isHiddenByOwner) return false;
    const states = await this.contentModeration.statesForAnyType(
      ListingLookupService.MODERATION_SUBJECT_TYPES,
      [listing.slug],
    );
    const moderationState = states.get(listing.slug);
    return (
      !moderationState || (!moderationState.hidden && !moderationState.removed)
    );
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
   *
   * The link target is a gathering's VENUE, so it must also be a place people
   * can walk into. An online-only listing has no premises, an out-and-about
   * (mobile) listing has no fixed premises (hosts link those businesses
   * through "Run by" instead), and an 18+ listing is kept off every public
   * surface while the venue page of a public gathering is one, so all three
   * are unlinkable. A place that ALSO sells online
   * (`online = false`, `hasOnlineShop = true`) keeps its address and stays
   * linkable.
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
        online: false,
        mobile: false,
        // Same in-query 18+ exclusion as `DirectoryService.PUBLICLY_LISTED`.
        cats: Not(ArrayContains([ADULT_LISTING_CATEGORY_SLUG])),
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
