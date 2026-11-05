import { type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import {
  directoryCategoryChipIds,
  directoryCategoryMatch,
  primaryCategoryClause,
  type DirectoryCategoryScope,
} from './directory-category-filter';
import { Listing, SafeSpaceStatus } from './entities/listing.entity';
import {
  LISTING_ACCESSIBILITY_QUESTION_SLUGS,
  ListingAccessibilityAnswer,
  type ListingAccessibilityQuestionSlug,
} from './listing-accessibility';
import {
  FILTERABLE_LISTING_ATTRIBUTE_SLUGS,
  LISTING_ENTRY_MODES,
  LISTING_INCLUSION_PRACTICES,
  LISTING_LANGUAGE_CODES,
  LISTING_PAYMENT_METHODS,
  type ListingEntryMode,
  type ListingInclusionPractice,
  type ListingLanguageCode,
  type ListingPaymentMethod,
} from './listing-attributes';
import {
  LISTING_OWNED_BY_VALUES,
  type ListingOwnedBy,
} from './listing-owned-by';

/**
 * The filter groups whose own predicate a facet base leaves off. Only the
 * groups where picking an option can widen or replace the result need it:
 * the categories, the owner tags and the languages are an OR, and the way in
 * is one choice that replaces another. Every other group (verified safe, out
 * and about, access needs, attributes, ways to pay, practices) only ever
 * narrows, so its counts come off the fully filtered base: "what I have now,
 * plus this one".
 */
export type DirectoryFacetLift = 'cat' | 'owned' | 'entry' | 'lang';

/**
 * `facets` on the first page of `GET /directory?page=`: how many listings
 * each filter option would show, counted under every other filter of the
 * request. Keyed by the same values the request takes, and always carrying
 * every value of each vocabulary, so a 0 is a real answer.
 *
 * Open now is not here: it is worked out in the browser on each place's own
 * clock (see `isPlaceOpenNow` in the frontend), and this read is CDN-cached.
 */
export interface DirectoryFacetCounts {
  /** Per category chip of the request's vocabulary (the place types, or the
   *  online ones with `online=true`), matched on the primary category. */
  categories: Record<string, number>;
  /** With the categories lifted: what "All" shows. A count of its own,
   *  since it is the one honest total whatever the chips add up to. */
  allCategories: number;
  /** With "Verified safe spaces" on. */
  safe: number;
  /** With "Out and about" on. */
  outAndAbout: number;
  /** Per owner tag, the tags lifted (they are an OR). */
  owned: Record<ListingOwnedBy, number>;
  /** Per access need, added to the ones already ticked. */
  access: Record<ListingAccessibilityQuestionSlug, number>;
  /** Per way in, the chosen one lifted (it is one choice). */
  entryModes: Record<ListingEntryMode, number>;
  /** Per way to pay, added to the ones already picked. */
  payments: Record<ListingPaymentMethod, number>;
  /** Per language, the languages lifted (they are an OR). */
  languages: Record<ListingLanguageCode, number>;
  /** Per inclusion practice, added to the ones already picked. */
  practices: Record<ListingInclusionPractice, number>;
  /** Per filterable attribute, added to the ones already picked. */
  attributes: Record<string, number>;
}

/** The option key "All" is counted under in the category scan. */
const ALL_CATEGORIES_OPTION = 'all';

/** `counts[prefix + value]` for each value, keyed by the bare value. */
function pickGroup<Value extends string>(
  counts: Record<string, number>,
  prefix: string,
  values: readonly Value[],
): Record<Value, number> {
  return Object.fromEntries(
    values.map((value) => [value, counts[`${prefix}${value}`] ?? 0]),
  ) as Record<Value, number>;
}

/** The verified badge as it reads today: granted and not under suspension.
 *  The same test `safe=verified` applies to the grid. */
const VERIFIED_BADGE_CLAUSE = `("listing"."safe_space_status" = '${SafeSpaceStatus.Verified}' AND NOT EXISTS (
        SELECT 1 FROM "safe_space_badge_suspensions" "ssbs"
        WHERE "ssbs"."listing_id" = "listing"."id"
          AND "ssbs"."lifted_at" IS NULL
      ))`;

/**
 * The narrowing groups, in ONE scan over the fully filtered base. Option
 * keys carry their group as a prefix, since an attribute slug and a payment
 * method could share a spelling.
 */
async function countNarrowingFacets(base: SelectQueryBuilder<Listing>) {
  const options = [
    'safe',
    'mobile',
    ...LISTING_ACCESSIBILITY_QUESTION_SLUGS.map((slug) => `access:${slug}`),
    ...LISTING_PAYMENT_METHODS.map((method) => `pay:${method}`),
    ...LISTING_INCLUSION_PRACTICES.map((practice) => `practice:${practice}`),
    ...FILTERABLE_LISTING_ATTRIBUTE_SLUGS.map((slug) => `attr:${slug}`),
  ];
  const valueOf = (option: string) => option.slice(option.indexOf(':') + 1);
  const counts = await countByFilterClauses(
    base,
    options,
    (param, option) => {
      if (option === 'safe') return VERIFIED_BADGE_CLAUSE;
      if (option === 'mobile') return '"listing"."mobile" = true';
      if (option.startsWith('access:')) {
        // Only a stored `yes` meets a need, exactly as the `access` filter.
        return `"listing"."accessibility_answers" @> CAST(:${param} AS jsonb)`;
      }
      if (option.startsWith('pay:')) {
        return `CAST(:${param} AS text) = ANY("listing"."payments")`;
      }
      if (option.startsWith('practice:')) {
        return `CAST(:${param} AS text) = ANY("listing"."inclusion_practices")`;
      }
      return `CAST(:${param} AS text) = ANY("listing"."attributes")`;
    },
    (option) =>
      option.startsWith('access:')
        ? JSON.stringify({ [valueOf(option)]: ListingAccessibilityAnswer.Yes })
        : valueOf(option),
  );
  return {
    safe: counts['safe'] ?? 0,
    outAndAbout: counts['mobile'] ?? 0,
    access: pickGroup(counts, 'access:', LISTING_ACCESSIBILITY_QUESTION_SLUGS),
    payments: pickGroup(counts, 'pay:', LISTING_PAYMENT_METHODS),
    practices: pickGroup(counts, 'practice:', LISTING_INCLUSION_PRACTICES),
    attributes: pickGroup(counts, 'attr:', FILTERABLE_LISTING_ATTRIBUTE_SLUGS),
  };
}

/**
 * The category chips and "All", in one scan over the base with the
 * categories lifted. Each chip's second parameter (the folded legacy values)
 * is bound on the builder before the scan, which `countByFilterClauses`
 * leaves in place.
 */
async function countCategoryFacets(
  base: SelectQueryBuilder<Listing>,
  scope: DirectoryCategoryScope,
) {
  const chipIds = directoryCategoryChipIds(scope);
  chipIds.forEach((chipId, index) => {
    base.setParameter(
      `facetCategoryLegacy${index}`,
      directoryCategoryMatch([chipId], scope).foldedLegacyValues,
    );
  });
  const counts = await countByFilterClauses(
    base,
    [...chipIds, ALL_CATEGORIES_OPTION],
    (param, option) =>
      option === ALL_CATEGORIES_OPTION
        ? 'TRUE'
        : primaryCategoryClause(
            param,
            `facetCategoryLegacy${chipIds.indexOf(option)}`,
          ),
    (option) =>
      option === ALL_CATEGORIES_OPTION
        ? null
        : directoryCategoryMatch([option], scope).storedValues,
  );
  return {
    categories: pickGroup(counts, '', chipIds),
    allCategories: counts[ALL_CATEGORIES_OPTION] ?? 0,
  };
}

/** One group of single-value options over its own lifted base. */
function countValueFacets<Value extends string>(
  base: SelectQueryBuilder<Listing>,
  values: readonly Value[],
  clause: (param: string) => string,
): Promise<Record<Value, number>> {
  return countByFilterClauses(base, values, clause, (value) => value);
}

/**
 * Every facet of the directory grid, from five aggregate scans that go out
 * together: the narrowing groups over the fully filtered base, then the
 * categories, the owner tags, the way in and the languages, each over a base
 * with its own group lifted. `baseFor` must hand back a FRESH builder each
 * call carrying the grid's exact filters and visibility gates (and no
 * ordering, which an aggregate cannot carry), so a count can never drift from
 * the cards it leads to.
 */
export async function countDirectoryFacets(
  baseFor: (lift: DirectoryFacetLift | null) => SelectQueryBuilder<Listing>,
  scope: DirectoryCategoryScope,
): Promise<DirectoryFacetCounts> {
  const [narrowing, category, owned, entryModes, languages] = await Promise.all(
    [
      countNarrowingFacets(baseFor(null)),
      countCategoryFacets(baseFor('cat'), scope),
      countValueFacets(
        baseFor('owned'),
        LISTING_OWNED_BY_VALUES,
        (param) => `CAST(:${param} AS text) = ANY("listing"."owned_by")`,
      ),
      countValueFacets(
        baseFor('entry'),
        LISTING_ENTRY_MODES,
        (param) => `"listing"."entry_mode" = :${param}`,
      ),
      countValueFacets(
        baseFor('lang'),
        LISTING_LANGUAGE_CODES,
        (param) => `CAST(:${param} AS text) = ANY("listing"."langs")`,
      ),
    ],
  );
  return {
    ...category,
    safe: narrowing.safe,
    outAndAbout: narrowing.outAndAbout,
    owned,
    access: narrowing.access,
    entryModes,
    payments: narrowing.payments,
    languages,
    practices: narrowing.practices,
    attributes: narrowing.attributes,
  };
}
