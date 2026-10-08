/**
 * The canonical directory category vocabulary — the single set of slugs shared
 * by the frontend map pins, category filter, and this API. Listings store these
 * slugs verbatim in `listing.cats`. This first list is the PLACE vocabulary, which mobile ("out and about") listings share;
 * online-only listings pick from `ONLINE_LISTING_CATEGORY_SLUGS` below.
 * Keeping the allowed set here, outside the DTO, means the create/update
 * validation and any category-keyed lookup reference one list.
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
  // Tours & experiences: walking tours, outdoor classes, anything people
  // join at a meeting point.
  'tours',
  // Home & moving: movers, cleaners, handypeople, plant care, the businesses
  // that come to you.
  'home-services',
] as const;

export type ListingCategorySlug = (typeof LISTING_CATEGORY_SLUGS)[number];

/**
 * The category vocabulary for ONLINE-ONLY listings (`listings.online ===
 * true`). A listing's `cats` are checked against the list that matches its own
 * `online` flag (`isListingCategoryOffered`), so a shop with no premises never
 * carries "Nightlife" and a bar never carries "Clothing & accessories".
 *
 * `food` sits in both lists: an online coffee roaster and a cafe are both
 * food. Mirrors the frontend's online vocabulary in `localCategories.ts`.
 */
export const ONLINE_LISTING_CATEGORY_SLUGS = [
  'apparel',
  'handmade',
  'books-music',
  'food',
  'body-care',
  'therapy',
  'classes',
  'services',
  'digital',
  'intimacy',
] as const;

export type OnlineListingCategorySlug =
  (typeof ONLINE_LISTING_CATEGORY_SLUGS)[number];

/**
 * The one 18+ category. Online only: the place vocabulary never offers it. A
 * listing carrying it needs the 18+ terms accepted (`adult_terms_required`),
 * and every public read leaves it out. Signed-in members reach these listings
 * through `GET /directory/adult` and the detail page.
 */
export const ADULT_LISTING_CATEGORY_SLUG =
  'intimacy' satisfies OnlineListingCategorySlug;

/** Every slug either vocabulary knows, each once: what the DTO's `@IsIn` accepts. */
export const ALL_LISTING_CATEGORY_SLUGS: readonly string[] = [
  ...new Set<string>([
    ...LISTING_CATEGORY_SLUGS,
    ...ONLINE_LISTING_CATEGORY_SLUGS,
  ]),
];

const PLACE_CATEGORY_SLUG_SET: ReadonlySet<string> = new Set(
  LISTING_CATEGORY_SLUGS,
);
const ONLINE_CATEGORY_SLUG_SET: ReadonlySet<string> = new Set(
  ONLINE_LISTING_CATEGORY_SLUGS,
);

/** Whether `slug` is offered to an online-only listing (`isOnline`) or to a place. */
export function isListingCategoryOffered(
  slug: string,
  isOnline: boolean,
): boolean {
  return isOnline
    ? ONLINE_CATEGORY_SLUG_SET.has(slug)
    : PLACE_CATEGORY_SLUG_SET.has(slug);
}

/** Whether a listing's categories make it an 18+ listing. A missing value reads as no. */
export function isAdultListing(
  cats: readonly string[] | null | undefined,
): boolean {
  return (cats ?? []).includes(ADULT_LISTING_CATEGORY_SLUG);
}
