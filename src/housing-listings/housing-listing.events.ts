import { HousingListing } from './entities/housing-listing.entity';

/**
 * Fired when a housing listing transitions INTO `live` from a non-live state
 * (the moderator approval in `HousingListingsService.setStatus`). The
 * saved-search alerts listener (housing-saved-searches) consumes it to match
 * the freshly-published listing against members' saved searches with alerts on,
 * and notify them through the existing NotificationsService.
 *
 * This is the deliberate seam between the two modules: housing-listings only
 * EMITS (via the global EventEmitter2, no import of the saved-searches module),
 * so there is no module cycle — the listener lives entirely on the consuming
 * side. `listingVerified` is computed once at the emit site (it needs the
 * lister's verification level) so the matcher can honour a `verifiedOnly`
 * saved search without re-deriving it per search.
 */
export const HOUSING_LISTING_WENT_LIVE = 'housing.listing.went_live';

export interface HousingListingWentLiveEvent {
  /** The just-published listing row (all fields the matcher reads). */
  listing: HousingListing;
  /** The server-derived "verified listing" state at publish time. */
  listingVerified: boolean;
}
