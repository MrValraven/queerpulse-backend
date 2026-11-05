import { type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import {
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';

/** The board's budget bands, the ids `?budgetBand=` takes. Each band's own
 *  predicate sits in `BUDGET_BAND_CLAUSES`, which both the list filter and the
 *  budget facets read, so a band's count and its results can never disagree. */
export const FLATMATE_BUDGET_BANDS = [
  'upTo700',
  '700to900',
  '900to1100',
  '1100plus',
] as const;
export type FlatmateBudgetBand = (typeof FLATMATE_BUDGET_BANDS)[number];

const BUDGET_BAND_CLAUSES: Record<FlatmateBudgetBand, string> = {
  upTo700: 'p.budget_euros <= 700',
  '700to900': '(p.budget_euros > 700 AND p.budget_euros <= 900)',
  '900to1100': '(p.budget_euros > 900 AND p.budget_euros <= 1100)',
  '1100plus': 'p.budget_euros > 1100',
};

/** The predicate for one budget band, over a profile builder aliased `p`. */
export function budgetBandClause(band: FlatmateBudgetBand): string {
  return BUDGET_BAND_CLAUSES[band];
}

const MOVE_IN_MONTHS = [
  'jan',
  'feb',
  'mar',
  'apr',
  'may',
  'jun',
  'jul',
  'aug',
  'sep',
  'oct',
  'nov',
  'dec',
] as const;

/** The move-in windows `?moveIn=` takes: `now`, `flex`, or a month key. */
export const FLATMATE_MOVE_IN_WINDOWS = [
  'now',
  'flex',
  ...MOVE_IN_MONTHS,
] as const;
export type FlatmateMoveInWindow = (typeof FLATMATE_MOVE_IN_WINDOWS)[number];

/**
 * The predicate for one move-in window, over a profile builder aliased `p`.
 * The windows never overlap, and they follow the card's own move-in line: a
 * profile with flexible timing OR no date reads "Flexible", one dated today or
 * earlier is available now, and a later date lands in its calendar month.
 * Every branch is a fixed string picked from the validated enum, so nothing
 * from the request reaches the SQL text.
 */
export function moveInWindowClause(window: FlatmateMoveInWindow): string {
  if (window === 'flex') {
    return '(p.flexible_timing = true OR p.move_in_from IS NULL)';
  }
  if (window === 'now') {
    return '(p.flexible_timing = false AND p.move_in_from <= CURRENT_DATE)';
  }
  const monthNumber = MOVE_IN_MONTHS.indexOf(window) + 1;
  return `(p.flexible_timing = false AND p.move_in_from > CURRENT_DATE AND EXTRACT(MONTH FROM p.move_in_from) = ${monthNumber})`;
}

/** One filter group on the board, the unit a facet count lifts. */
export type FlatmateFacetGroup =
  'type' | 'neighbourhood' | 'budget' | 'moveIn' | 'tags';

/**
 * `GET /flatmate-directory`'s `facets`, on page 1 only: how many profiles each
 * sidebar option would yield, counted with that group's own predicate lifted
 * and every other filter applied. The `all*` fields are the group's "Any" row,
 * a distinct total over the lifted base (never a sum of overlapping options).
 *
 * `neighbourhood` is keyed by the LOWERCASED name, the same case-insensitive
 * reading the `neighbourhood` filter applies; a name with no profiles is
 * absent, which means 0. `tags` is keyed by the exact tag (the array filters
 * are case-sensitive) and counted against the current tag selection: under
 * `tagMatch=all` with the selected tags applied (each count answers "how many
 * would I get adding this tag"), under the legacy `any` with the tag filter
 * lifted. A tag nobody in that set carries is absent, which means 0.
 */
export interface FlatmateDirectoryFacets {
  type: Record<FlatmateProfileType, number>;
  allTypes: number;
  neighbourhood: Record<string, number>;
  allNeighbourhoods: number;
  budget: Record<FlatmateBudgetBand, number>;
  allBudgets: number;
  moveIn: Record<FlatmateMoveInWindow, number>;
  allMoveIns: number;
  tags: Record<string, number>;
}

/** One `GROUP BY` row: the grouped value and its count. Postgres returns
 *  `COUNT(*)` as a bigint, which node-postgres hands back as a string. */
interface FacetCountRow {
  value: string | null;
  profile_count: string | number;
}

// The extra option every enum group counts in the same scan: the lifted
// base's own total, for the group's "Any" row.
const ANY_OPTION = '__any';

/**
 * Counts an enum group's options plus its "Any" total in one aggregate scan,
 * then splits the total off. Mutates the builder it is handed, so pass a
 * fresh one.
 */
async function countEnumGroup<Option extends string>(
  base: SelectQueryBuilder<FlatmateProfile>,
  options: readonly Option[],
  clauseFor: (option: Option, param: string) => string,
): Promise<{ counts: Record<Option, number>; total: number }> {
  const counted = await countByFilterClauses(
    base,
    [...options, ANY_OPTION],
    (param, option) =>
      option === ANY_OPTION ? 'TRUE' : clauseFor(option as Option, param),
    (option) => option,
  );
  const counts = Object.fromEntries(
    options.map((option) => [option, counted[option] ?? 0]),
  ) as Record<Option, number>;
  return { counts, total: counted[ANY_OPTION] ?? 0 };
}

/** Profile type counts over the type-lifted base. */
export function countFlatmateTypeFacets(
  base: SelectQueryBuilder<FlatmateProfile>,
) {
  return countEnumGroup(
    base,
    Object.values(FlatmateProfileType),
    (_option, param) => `p.type = :${param}`,
  );
}

/** Budget band counts over the budget-lifted base (band and ceiling both). */
export function countFlatmateBudgetFacets(
  base: SelectQueryBuilder<FlatmateProfile>,
) {
  return countEnumGroup(base, FLATMATE_BUDGET_BANDS, (band) =>
    budgetBandClause(band),
  );
}

/** Move-in window counts over the move-in-lifted base. The windows do not
 *  cover every profile (a date months out sits in a month the board may not
 *  offer), so the "Any" total is counted, never summed. */
export function countFlatmateMoveInFacets(
  base: SelectQueryBuilder<FlatmateProfile>,
) {
  return countEnumGroup(base, FLATMATE_MOVE_IN_WINDOWS, (window) =>
    moveInWindowClause(window),
  );
}

/**
 * Neighbourhood counts over the neighbourhood-lifted base, grouped by the
 * lowercased name. Each profile names one neighbourhood, so the groups
 * partition the base and their sum (the empty name included) is the distinct
 * "Any" total. Mutates the builder it is handed, so pass a fresh one.
 */
export async function countFlatmateNeighbourhoodFacets(
  base: SelectQueryBuilder<FlatmateProfile>,
): Promise<{ counts: Record<string, number>; total: number }> {
  const rows = await base
    .select('LOWER(p.neighbourhood)', 'value')
    .addSelect('COUNT(*)', 'profile_count')
    .groupBy('LOWER(p.neighbourhood)')
    .getRawMany<FacetCountRow>();
  const counts: Record<string, number> = {};
  let total = 0;
  for (const row of rows) {
    const count = Number(row.profile_count);
    total += count;
    if (row.value) counts[row.value] = count;
  }
  return { counts, total };
}

/**
 * Lifestyle tag counts over the base the caller picks (see
 * `FlatmateDirectoryFacets.tags`). A profile lists many tags, so it counts
 * once under EACH of them. `unnest` fans each row out into one row per tag,
 * and Postgres rejects a set-returning function in `GROUP BY`, so the fan-out
 * runs as a subquery the outer query groups over, carrying its bound
 * parameters (the filters and both visibility gates). `COUNT(DISTINCT)` keeps
 * a tag stored twice on one profile from counting it twice.
 */
export async function countFlatmateTagFacets(
  base: SelectQueryBuilder<FlatmateProfile>,
  manager: EntityManager,
): Promise<Record<string, number>> {
  const tagsPerProfile = base
    .select('p.id', 'profile_id')
    .addSelect('unnest(p.lifestyle_tags)', 'tag');
  const rows = await manager
    .createQueryBuilder()
    .select('"profile_tag"."tag"', 'value')
    .addSelect('COUNT(DISTINCT "profile_tag"."profile_id")', 'profile_count')
    .from(`(${tagsPerProfile.getQuery()})`, 'profile_tag')
    .setParameters(tagsPerProfile.getParameters())
    .groupBy('"profile_tag"."tag"')
    .getRawMany<FacetCountRow>();
  const counts: Record<string, number> = {};
  for (const row of rows) {
    if (row.value) counts[row.value] = Number(row.profile_count);
  }
  return counts;
}
