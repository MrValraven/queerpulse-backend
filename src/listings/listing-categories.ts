/**
 * The canonical directory category vocabulary — the single set of slugs shared
 * by the frontend map pins, category filter, and this API. Listings store these
 * slugs verbatim in `listing.cats`. Keeping the allowed set here (rather than an
 * inline literal in the DTO) means the create/update validation and any
 * category-keyed lookup reference one list.
 *
 * Mirrors the frontend `LOCAL_CATEGORIES` in
 * queerpulse/src/features/marketing/localPlaces.ts.
 */
export const LISTING_CATEGORY_SLUGS = [
  'food',
  'design',
  'health',
  'space',
  'culture',
  'tech',
  'grooming',
  'fitness',
  'nightlife',
] as const;

export type ListingCategorySlug = (typeof LISTING_CATEGORY_SLUGS)[number];
