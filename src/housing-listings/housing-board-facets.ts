import { type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { VerificationLevel } from '../verification/verification-level';
import { BrowseHousingListingsQuery } from './dto/browse-housing-listings.query';
import {
  HousingListing,
  HousingListingType,
} from './entities/housing-listing.entity';
import {
  HOUSING_FURNISHED_FEATURE,
  HOUSING_PETS_WELCOME_FEATURE,
  normalizeHousingFeature,
} from './housing-features';
import { VERIFIED_LISTING_MAX_RISK } from './housing-verified';

/** The yes/no "Must have" narrowings of the housing board. They AND together:
 *  a listing has to satisfy every ticked one. */
export type HousingMustHaveFlag =
  | 'billsIncluded'
  | 'hasAccessibilityInfo'
  | 'furnished'
  | 'petsWelcome'
  | 'verifiedOnly';

export const HOUSING_MUST_HAVE_FLAGS: readonly HousingMustHaveFlag[] = [
  'billsIncluded',
  'hasAccessibilityInfo',
  'furnished',
  'petsWelcome',
  'verifiedOnly',
];

/** The filter groups whose options carry a count. Each is lifted, one at a
 *  time, from `HousingDirectoryService.browseBaseQuery` to count its own
 *  options. The value inputs (price, deposit, move-in date) carry no count
 *  and are never lifted. */
export type HousingFacetGroup = 'type' | 'area' | 'bedrooms' | 'mustHave';

/** The board's minimum-bedrooms choices (0 = studio and up). Each is a
 *  `bedrooms >= N` threshold, so the thresholds nest: every listing counted
 *  under "2+" is counted under "1+" as well. Mirrors `BEDROOM_OPTIONS` in the
 *  frontend's `housing.data.ts`. */
export const HOUSING_BEDROOM_THRESHOLDS: readonly number[] = [0, 1, 2, 3];

/** The "All" / "Any" row's key in the type and bedrooms counts. */
const ALL_OPTION = 'all';

/**
 * The housing board sidebar's availability counts, sent with
 * `GET /housing-directory`. Each group is counted with its own filter lifted
 * and every other filter of the request applied (the price, deposit and
 * move-in values included), so a number says how many listings picking that
 * option would leave.
 */
export interface HousingBoardFacetCounts {
  /** Listings per listing type, under every filter except `type`. */
  type: Record<HousingListingType, number>;
  /** Listings under every filter except `type`: the "All" row's count. */
  allTypes: number;
  /** Listings per neighbourhood, keyed by the lowercased `area` the
   *  `areas` filter compares against, under every filter except the
   *  neighbourhood ones. A neighbourhood with no listing has no key. */
  areas: Record<string, number>;
  /** Listings per minimum-bedrooms threshold (keys "0" to "3", each a
   *  `bedrooms >= N` count), under every filter except `bedroomsMin`. They
   *  nest, so they never sum to a total. */
  bedroomsMin: Record<string, number>;
  /** Listings under every filter except `bedroomsMin`, each counted once:
   *  the "Any" row's count. */
  allBedrooms: number;
  /** Per flag: listings with that flag on, under every other ticked flag and
   *  every other filter. A ticked flag's count is the board's own total. */
  mustHave: Record<HousingMustHaveFlag, number>;
}

/** One SQL predicate over a listing (alias `l`) and the parameters it binds. */
interface HousingPredicate {
  clause: string;
  parameters: Record<string, unknown>;
}

/**
 * "This listing's `features` array carries the chip bound to `parameter`",
 * as SQL. `features` is a `text[]`, so this unnests it and compares each
 * entry whole, case-insensitively: the exact contract
 * `hasHousingFeature`/`normalizeHousingFeature` implement in memory for the
 * saved-search alert fan-out. The two must keep agreeing, or an alert fires
 * for a listing the board would not show.
 *
 * `= ANY(:array)` (the shape the `areas` multi-select uses) is deliberately
 * NOT the operator here: that tests one scalar column against a list of
 * candidate values, where this tests one candidate value against a list held
 * in the column.
 */
function featurePredicate(parameter: string): string {
  return `EXISTS (
      SELECT 1 FROM unnest(l.features) AS listing_feature
      WHERE lower(btrim(listing_feature)) = :${parameter}
    )`;
}

/**
 * One "Must have" flag as SQL. The browse applies these for its ticked flags,
 * and the facet count reuses the very same strings, so a checkbox can never
 * promise a number its filter then disagrees with.
 */
export function mustHavePredicate(flag: HousingMustHaveFlag): HousingPredicate {
  switch (flag) {
    case 'billsIncluded':
      return { clause: 'l.bills_included = true', parameters: {} };
    case 'hasAccessibilityInfo':
      return { clause: "l.accessibility_info <> ''", parameters: {} };
    case 'furnished':
      return {
        clause: featurePredicate('furnishedFeature'),
        parameters: {
          furnishedFeature: normalizeHousingFeature(HOUSING_FURNISHED_FEATURE),
        },
      };
    case 'petsWelcome':
      return {
        clause: featurePredicate('petsWelcomeFeature'),
        parameters: {
          petsWelcomeFeature: normalizeHousingFeature(
            HOUSING_PETS_WELCOME_FEATURE,
          ),
        },
      };
    case 'verifiedOnly':
      // The public "verified listing" derivation, expressed in-query: status
      // is already `live` in the base query, so verified reduces to a low
      // pre-publish risk score AND an id-verified lister. Kept in lockstep
      // with `deriveListingVerified` (housing-verified.ts).
      return {
        clause: `l.risk_score < :maxRisk AND EXISTS (
          SELECT 1 FROM "member_verifications" "mv"
          WHERE "mv"."user_id" = l.owner_id
            AND "mv"."level" = :idVerifiedLevel
        )`,
        parameters: {
          maxRisk: VERIFIED_LISTING_MAX_RISK,
          idVerifiedLevel: VerificationLevel.IdVerified,
        },
      };
  }
}

/** The flags this request ticked. Only `true` narrows the board. */
export function activeMustHaveFlags(
  query: BrowseHousingListingsQuery,
): HousingMustHaveFlag[] {
  return HOUSING_MUST_HAVE_FLAGS.filter((flag) => query[flag] === true);
}

/**
 * Listings per type plus the "All" total, in ONE aggregate scan over the
 * base query with the `type` filter lifted. Types are exclusive, but the
 * total is still counted on its own rather than summed.
 *
 * Mutates the builder it is handed (its SELECT list is replaced), so pass a
 * fresh one.
 */
export async function countHousingTypeFacets(
  base: SelectQueryBuilder<HousingListing>,
): Promise<Pick<HousingBoardFacetCounts, 'type' | 'allTypes'>> {
  const types = Object.values(HousingListingType);
  const counts = await countByFilterClauses(
    base,
    [...types, ALL_OPTION],
    (param, option) => (option === ALL_OPTION ? 'TRUE' : `l.type = :${param}`),
    (option) => option,
  );
  const typeCounts = Object.fromEntries(
    types.map((type) => [type, counts[type] ?? 0]),
  ) as Record<HousingListingType, number>;
  return { type: typeCounts, allTypes: counts[ALL_OPTION] ?? 0 };
}

/**
 * Listings per minimum-bedrooms threshold plus the "Any" total, in ONE
 * aggregate scan over the base query with the `bedroomsMin` filter lifted.
 * Each threshold is the filter's own `l.bedrooms >= N`, so a listing with no
 * bedroom count set is counted only under "Any", exactly as the filter
 * leaves it out.
 *
 * Mutates the builder it is handed, so pass a fresh one.
 */
export async function countHousingBedroomFacets(
  base: SelectQueryBuilder<HousingListing>,
): Promise<Pick<HousingBoardFacetCounts, 'bedroomsMin' | 'allBedrooms'>> {
  const thresholdKeys = HOUSING_BEDROOM_THRESHOLDS.map(String);
  const counts = await countByFilterClauses(
    base,
    [...thresholdKeys, ALL_OPTION],
    (param, option) =>
      option === ALL_OPTION ? 'TRUE' : `l.bedrooms >= :${param}`,
    (option) => (option === ALL_OPTION ? null : Number(option)),
  );
  const bedroomsMin = Object.fromEntries(
    thresholdKeys.map((key) => [key, counts[key] ?? 0]),
  );
  return { bedroomsMin, allBedrooms: counts[ALL_OPTION] ?? 0 };
}

/** One `GROUP BY` row of the neighbourhood count. Postgres returns
 *  `COUNT(*)` as a bigint, which node-postgres hands back as a string. */
interface AreaCountRow {
  area_key: string | null;
  listing_count: string | number;
}

/**
 * Listings per neighbourhood over the base query with the `area` and `areas`
 * filters lifted. Grouped on `LOWER(l.area)`, the same expression the
 * `areas` filter compares, so a neighbourhood's number is what ticking it
 * gives. The neighbourhood list lives in the frontend, so only areas that
 * hold a listing come back; a missing key reads as zero there.
 *
 * Mutates the builder it is handed, so pass a fresh one.
 */
export async function countHousingAreaFacets(
  base: SelectQueryBuilder<HousingListing>,
): Promise<Record<string, number>> {
  const rows = await base
    .select('LOWER(l.area)', 'area_key')
    .addSelect('COUNT(*)', 'listing_count')
    .groupBy('LOWER(l.area)')
    .getRawMany<AreaCountRow>();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.area_key) counts[row.area_key] = Number(row.listing_count);
  }
  return counts;
}

/**
 * One count per "Must have" flag, in ONE aggregate scan over the base query
 * with every flag lifted. A flag's count applies that flag and every OTHER
 * ticked flag, so it answers "how many would I get if I also ticked this",
 * and a ticked flag reads the board's current total.
 *
 * Mutates the builder it is handed, so pass a fresh one.
 */
export async function countHousingMustHaveFacets(
  base: SelectQueryBuilder<HousingListing>,
  query: BrowseHousingListingsQuery,
): Promise<Record<HousingMustHaveFlag, number>> {
  const tickedFlags = activeMustHaveFlags(query);
  const predicates = Object.fromEntries(
    HOUSING_MUST_HAVE_FLAGS.map((flag) => [flag, mustHavePredicate(flag)]),
  ) as Record<HousingMustHaveFlag, HousingPredicate>;
  for (const flag of HOUSING_MUST_HAVE_FLAGS) {
    base.setParameters(predicates[flag].parameters);
  }
  const counts = await countByFilterClauses(
    base,
    HOUSING_MUST_HAVE_FLAGS,
    // The per-option parameter goes unused: every flag's own parameters are
    // already set on the builder above.
    (_param, option) => {
      const flag = option as HousingMustHaveFlag;
      const appliedFlags = [
        flag,
        ...tickedFlags.filter((ticked) => ticked !== flag),
      ];
      return appliedFlags
        .map((applied) => `(${predicates[applied].clause})`)
        .join(' AND ');
    },
    () => null,
  );
  return Object.fromEntries(
    HOUSING_MUST_HAVE_FLAGS.map((flag) => [flag, counts[flag] ?? 0]),
  ) as Record<HousingMustHaveFlag, number>;
}
