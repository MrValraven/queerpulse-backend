import {
  ALL_LISTING_CATEGORY_SLUGS,
  LISTING_CATEGORY_SLUGS,
  ONLINE_LISTING_CATEGORY_SLUGS,
} from './listing-categories';

/**
 * The vocabulary the directory's category chips read in: the place types on
 * the List and Map tabs, what a business sells on the Online tab
 * (`online=true`, and the members-only `GET /directory/adult`).
 */
export type DirectoryCategoryScope = 'place' | 'online';

/**
 * The online category a place category reads as. Mirrors the frontend's
 * `ONLINE_CATEGORY_FOR_PLACE_CATEGORY` in `localCategories.ts`: the same
 * pairs as the 2026-10-07 data migration, plus `home-services` reading as
 * Creative services. Every online slug appears on the right at most once, so
 * the reverse map below is a plain inversion.
 */
const ONLINE_CATEGORY_FOR_PLACE_CATEGORY: Readonly<Record<string, string>> = {
  food: 'food',
  design: 'handmade',
  culture: 'books-music',
  health: 'therapy',
  tech: 'digital',
  grooming: 'body-care',
  fitness: 'classes',
  'home-services': 'services',
};

const PLACE_CATEGORY_FOR_ONLINE_CATEGORY: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(ONLINE_CATEGORY_FOR_PLACE_CATEGORY).map(
      ([placeCategory, onlineCategory]) => [onlineCategory, placeCategory],
    ),
  );

/**
 * Stored values from before categories were slugs, lowercased and trimmed,
 * to the slug they read as: the early wizard's display labels and the folded
 * venue types. Mirrors the frontend's `CATEGORY_LABEL_TO_SLUG` and
 * `VENUE_TYPE_TO_CATEGORY`, which `normalizeCategory` heals at read time, so
 * a legacy row sits under the same chip in the grid as in this filter.
 */
const LEGACY_CATEGORY_VALUES: Readonly<Record<string, string>> = {
  'food & drink': 'food',
  'design & craft': 'design',
  'health & care': 'health',
  spaces: 'space',
  culture: 'culture',
  tech: 'tech',
  'barbershop & salon': 'grooming',
  'gym & fitness': 'fitness',
  nightlife: 'nightlife',
  'tours & experiences': 'tours',
  'home & moving': 'home-services',
  café: 'food',
  clinic: 'health',
  gym: 'fitness',
  barbershop: 'grooming',
  bookshop: 'culture',
  'community space': 'space',
  bar: 'nightlife',
  club: 'nightlife',
  sauna: 'nightlife',
};

/** A canonical slug as the scope's chips read it. */
function slugInScope(slug: string, scope: DirectoryCategoryScope): string {
  return scope === 'online'
    ? (ONLINE_CATEGORY_FOR_PLACE_CATEGORY[slug] ?? slug)
    : (PLACE_CATEGORY_FOR_ONLINE_CATEGORY[slug] ?? slug);
}

/** The chip ids a scope offers, in chip order: what the facets are keyed by. */
export function directoryCategoryChipIds(
  scope: DirectoryCategoryScope,
): readonly string[] {
  return scope === 'online'
    ? ONLINE_LISTING_CATEGORY_SLUGS
    : LISTING_CATEGORY_SLUGS;
}

/**
 * The stored values that read as any of `chipIds`: canonical slugs compared
 * as stored, legacy values compared lowercased and trimmed. Two lists because
 * the frontend heals a value exactly that way (a canonical slug passes
 * through untouched, anything else is folded and looked up).
 */
export interface DirectoryCategoryMatch {
  storedValues: string[];
  foldedLegacyValues: string[];
}

export function directoryCategoryMatch(
  chipIds: readonly string[],
  scope: DirectoryCategoryScope,
): DirectoryCategoryMatch {
  const wantedChipIds = new Set(chipIds);
  return {
    storedValues: ALL_LISTING_CATEGORY_SLUGS.filter((slug) =>
      wantedChipIds.has(slugInScope(slug, scope)),
    ),
    foldedLegacyValues: Object.entries(LEGACY_CATEGORY_VALUES)
      .filter(([, slug]) => wantedChipIds.has(slugInScope(slug, scope)))
      .map(([value]) => value),
  };
}

/**
 * SQL for "the listing's primary category reads as one of the chips", over
 * two bound `text[]` parameters holding a `DirectoryCategoryMatch`. The
 * primary category is the first of `cats` (Postgres arrays count from 1),
 * which is the one category a card shows and the one the grid's chips have
 * always matched on, so a listing filed under two categories sits under one
 * chip and the category counts never overlap. An empty `cats` has no first
 * entry and matches no chip, only "All".
 */
export function primaryCategoryClause(
  storedValuesParam: string,
  foldedLegacyValuesParam: string,
): string {
  return `("listing"."cats"[1] = ANY(CAST(:${storedValuesParam} AS text[])) OR lower(btrim("listing"."cats"[1])) = ANY(CAST(:${foldedLegacyValuesParam} AS text[])))`;
}
