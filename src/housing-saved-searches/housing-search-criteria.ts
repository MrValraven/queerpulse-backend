import {
  HousingListing,
  HousingListingType,
} from '../housing-listings/entities/housing-listing.entity';

/**
 * The stored, structured filter set behind a saved search — the same knobs the
 * housing directory browse accepts, persisted as jsonb so a member can re-run
 * or be alerted on exactly the search they built. Every field is optional; an
 * empty object means "any live listing".
 *
 * Kept deliberately in lockstep with `BrowseHousingListingsQuery`
 * (housing-listings/dto): the browse SQL and `matchesHousingCriteria` below are
 * two evaluators of the same criteria — one in Postgres for the live list, one
 * in memory for the go-live alert fan-out — so they must agree.
 */
export interface HousingSearchCriteria {
  type?: HousingListingType;
  city?: string;
  area?: string;
  /** Neighbourhood multi-select. When present + non-empty this is the area
   * filter; the legacy single `area` above is the fallback for older searches. */
  areas?: string[];
  priceMin?: number;
  priceMax?: number;
  bedroomsMin?: number;
  billsIncluded?: boolean;
  hasAccessibilityInfo?: boolean;
  verifiedOnly?: boolean;
  /** YYYY-MM-DD move-in-by date. */
  availableBy?: string;
}

function equalsCaseInsensitive(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/**
 * Whether a just-published listing satisfies a saved search's criteria. The
 * in-memory mirror of the directory browse's `.andWhere` chain — same
 * semantics: a listing with no `bedrooms`/`availableFrom` is handled exactly as
 * the SQL handles it. `listingVerified` is passed in (derived once at the emit
 * site) so the `verifiedOnly` gate needs no per-search verification lookup.
 */
export function matchesHousingCriteria(
  listing: HousingListing,
  criteria: HousingSearchCriteria,
  listingVerified: boolean,
): boolean {
  if (criteria.type && listing.type !== criteria.type) return false;
  if (criteria.city && !equalsCaseInsensitive(listing.city, criteria.city)) {
    return false;
  }
  if (criteria.areas?.length) {
    if (
      !criteria.areas.some((area) => equalsCaseInsensitive(listing.area, area))
    ) {
      return false;
    }
  } else if (
    criteria.area &&
    !equalsCaseInsensitive(listing.area, criteria.area)
  ) {
    return false;
  }
  if (
    criteria.priceMin !== undefined &&
    listing.rentEuros < criteria.priceMin
  ) {
    return false;
  }
  if (
    criteria.priceMax !== undefined &&
    listing.rentEuros > criteria.priceMax
  ) {
    return false;
  }
  if (criteria.bedroomsMin !== undefined) {
    if (listing.bedrooms === null || listing.bedrooms < criteria.bedroomsMin) {
      return false;
    }
  }
  if (criteria.billsIncluded && !listing.billsIncluded) return false;
  if (
    criteria.hasAccessibilityInfo &&
    listing.accessibilityInfo.trim() === ''
  ) {
    return false;
  }
  if (criteria.verifiedOnly && !listingVerified) return false;
  if (criteria.availableBy) {
    // A listing with no move-in date is available anytime (matches the SQL).
    if (listing.availableFrom && listing.availableFrom > criteria.availableBy) {
      return false;
    }
  }
  return true;
}
