import {
  Listing,
  ListingOperatingState,
  ListingStatus,
} from './entities/listing.entity';

/**
 * PRD-434. Where a suggested place stands, in the suggester's words. The
 * first three follow `ListingStatus` (one per status, so a new moderation
 * status cannot compile without one).
 *
 * `with_business` is for a place another member's business has claimed and
 * that is not publicly visible. Its review state belongs to that business: a
 * moderator's question goes to the owner, and a listing the owner hid is the
 * owner's call. The suggester learns only that the business has it.
 *
 * A suggestion a moderator declined has no state here because it has no row:
 * `removeByModerator` deletes the listing and tells the suggester through the
 * `listing_suggestion_removed` bell row, which is where that verdict lives.
 */
export type MySuggestedListingState =
  'in_review' | 'needs_info' | 'published' | 'with_business';

const SUGGESTION_STATE_FOR_STATUS: Record<
  ListingStatus,
  Exclude<MySuggestedListingState, 'with_business'>
> = {
  [ListingStatus.Review]: 'in_review',
  [ListingStatus.Question]: 'needs_info',
  [ListingStatus.Live]: 'published',
};

/**
 * Who holds the listing now. A suggestion starts held by the platform; a claim
 * or an owner offer hands it to the business, which may be the suggester
 * themselves.
 */
export type MySuggestedListingHolder =
  'platform' | 'claimed_by_you' | 'claimed';

/**
 * One place the caller suggested for the directory (`GET
 * /listings/suggestions/mine`). Hand-mapped and deliberately narrow: the
 * suggestion grants its member nothing on the listing, so this carries only
 * what the member needs to follow it up: the place, where it stands, and who
 * holds it now. Owner identity, contact details and moderator notes stay off
 * it.
 */
export interface MySuggestedListingDTO {
  ref: string;
  name: string;
  city: string;
  state: MySuggestedListingState;
  holder: MySuggestedListingHolder;
  /**
   * The public directory slug, set only while the public page resolves: the
   * listing is live and its owner has not hidden it. Null otherwise, so the
   * client never links to a page that would 404.
   */
  publicSlug: string | null;
  /** True once the business reported it shut for good (still browsable). */
  isPermanentlyClosed: boolean;
  /** ISO 8601, when the member sent the suggestion. */
  suggestedAt: string;
}

export function toMySuggestedListingDTO(
  listing: Pick<
    Listing,
    | 'ref'
    | 'name'
    | 'city'
    | 'slug'
    | 'status'
    | 'ownerId'
    | 'isHiddenByOwner'
    | 'operatingState'
    | 'createdAt'
  >,
  viewerId: string,
): MySuggestedListingDTO {
  const isPubliclyVisible =
    listing.status === ListingStatus.Live && !listing.isHiddenByOwner;
  const holder: MySuggestedListingHolder =
    listing.ownerId === null
      ? 'platform'
      : listing.ownerId === viewerId
        ? 'claimed_by_you'
        : 'claimed';
  // Another business holds it: the suggester sees only what the public
  // directory shows, so a review status or a closure the public cannot see
  // stays with that business.
  const isHeldByAnotherBusiness = holder === 'claimed';
  const canShowListingState = !isHeldByAnotherBusiness || isPubliclyVisible;
  return {
    ref: listing.ref,
    name: listing.name,
    city: listing.city,
    state: canShowListingState
      ? SUGGESTION_STATE_FOR_STATUS[listing.status]
      : 'with_business',
    holder,
    publicSlug: isPubliclyVisible ? listing.slug : null,
    isPermanentlyClosed:
      canShowListingState &&
      listing.operatingState === ListingOperatingState.PermanentlyClosed,
    suggestedAt: listing.createdAt.toISOString(),
  };
}
