import { type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import type { EventCostFilter } from './dto/list-events.query';
import { type Event } from './entities/event.entity';
import { GATHERING_FAMILY_VALUES, GatheringFamily } from './gathering-family';

/*
 * The upcoming browse's availability counts (`GET /events?facets=true`): how
 * many events picking each filter option would give, counted with that
 * option's own group lifted and every other filter (and the search) still
 * applied. `EventsService.buildUpcomingBrowseQuery` builds each group's base
 * with its `lift`, and the list itself goes through the same builder with
 * nothing lifted, so a count and the page it promises cannot drift apart.
 *
 * The discovery predicates are spelled here once, under alias `e`, and
 * `EventsService.applyDiscoveryFilters` builds its WHERE clauses from them.
 */

/** A filter group a facet count can lift. `when` lifts `from` and `to`
 *  together, since the two bounds are one chip. */
export type EventBrowseFacetGroup =
  'family' | 'when' | 'hood' | 'type' | 'cost';

/** The date chips the browse board offers besides "Any time". The client
 *  owns their bounds (`whenPresetRange` in the frontend's
 *  `hub/browseFilters.ts`, read in the member's own clock) and sends each one
 *  as a `whenWindow`, so a count uses the exact `from`/`to` the chip would. */
export const EVENT_WHEN_FACET_KEYS = [
  'today',
  'weekend',
  'week',
  'month',
] as const;
export type EventWhenFacetKey = (typeof EVENT_WHEN_FACET_KEYS)[number];

/** One date chip's window, parsed from a `whenWindow` entry. */
export interface EventWhenWindow {
  key: EventWhenFacetKey;
  from: Date;
  to: Date;
}

/** One group's counts. `all` is the distinct number of events with this
 *  group lifted, which is what its "Any" option yields. The server counts it
 *  directly: date windows overlap, so their counts add up past the total. */
export interface EventFacetGroupCounts<Option extends string> {
  options: Partial<Record<Option, number>>;
  all: number;
}

/**
 * The `facets` object on a browse page. `family` and `cost` always carry
 * every option (0 when nothing is filed under it). `hood` and `type` are keyed
 * by the LOWERCASED stored value, the form their filters compare in, and list
 * only the values some event carries, so a missing key is a 0. `when` carries
 * exactly the windows the request sent and parsed: a chip whose window is
 * missing was not counted.
 */
export interface EventBrowseFacets {
  family: EventFacetGroupCounts<GatheringFamily>;
  when: EventFacetGroupCounts<EventWhenFacetKey>;
  hood: EventFacetGroupCounts<string>;
  type: EventFacetGroupCounts<string>;
  cost: EventFacetGroupCounts<EventCostFilter>;
}

/** Lower bound of a discovery window: the event is still running at or after
 *  `:<param>`. See `applyDiscoveryFilters` for why it is an intersection. */
export function discoveryFromSql(param: string): string {
  return `(e.start_at >= :${param} OR (e.end_at IS NOT NULL AND e.end_at >= :${param}))`;
}

/** Upper bound of a discovery window: the event starts by `:<param>`. */
export function discoveryToSql(param: string): string {
  return `e.start_at <= :${param}`;
}

/** The column expressions the `family`, `hood` and `type` filters compare,
 *  and the facet counts group by. */
export const FAMILY_FACET_KEY_SQL = 'e.gathering_family';
export const HOOD_FACET_KEY_SQL = 'lower(e.neighbourhood)';
export const TYPE_FACET_KEY_SQL = 'lower(e.event_type)';

/** Free and paid, the SQL half of `isFreeCost`, bound to
 *  `:...freeCostLabels` (`EventsService.FREE_COST_LABELS`). */
export const FREE_COST_SQL = `(e.cost IS NULL OR btrim(e.cost) = '' OR lower(btrim(e.cost)) = ANY(:freeCostLabels))`;
export const PAID_COST_SQL = `(e.cost IS NOT NULL AND btrim(e.cost) <> '' AND NOT (lower(btrim(e.cost)) = ANY(:freeCostLabels)))`;

/** The option `countByFilterClauses` reads the group total from. The date and
 *  cost option sets are closed, so it can never collide with one of them. */
const ALL_OPTION = 'all';

/**
 * The `whenWindow` entries a request sent, each `key,fromIso,toIso`. An
 * entry with an unknown key, the wrong shape or a date that does not parse
 * is dropped, which leaves that chip uncounted. The first entry for a key
 * wins.
 */
export function parseWhenWindows(
  entries: readonly string[] | undefined,
): EventWhenWindow[] {
  const windows: EventWhenWindow[] = [];
  for (const entry of entries ?? []) {
    const [key, fromText, toText, ...rest] = entry.split(',');
    if (rest.length || !key || !fromText || !toText) continue;
    const isKnownKey = (EVENT_WHEN_FACET_KEYS as readonly string[]).includes(
      key,
    );
    if (!isKnownKey || windows.some((window) => window.key === key)) continue;
    const from = new Date(fromText);
    const to = new Date(toText);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) continue;
    windows.push({ key: key as EventWhenFacetKey, from, to });
  }
  return windows;
}

/** One `GROUP BY` row. node-postgres hands `COUNT(*)` back as a string. */
interface FacetValueRow {
  value: string | null;
  event_count: string | number;
}

/**
 * Counts per stored value of `keySql` over a base with this group lifted.
 * The group is a single scalar column, so each event lands in exactly one
 * row and `all` is their sum, the rows without a value included (an event
 * with no neighbourhood still counts under "Anywhere in Lisbon").
 *
 * Mutates the builder it is handed (its SELECT list is replaced), so pass a
 * fresh one.
 */
async function countGroupedFacet(
  base: SelectQueryBuilder<Event>,
  keySql: string,
): Promise<EventFacetGroupCounts<string>> {
  const rows = await base
    .select(keySql, 'value')
    .addSelect('COUNT(*)', 'event_count')
    .groupBy(keySql)
    .getRawMany<FacetValueRow>();
  const options: Record<string, number> = {};
  let all = 0;
  for (const row of rows) {
    const count = Number(row.event_count);
    all += count;
    if (row.value) options[row.value] = count;
  }
  return { options, all };
}

/** Family counts, every family keyed (0 when nobody is filed under it). A
 *  value outside the enum is dropped from `options` and still counted in
 *  `all`, so the wire keys stay exactly the enum. */
export async function countFamilyFacets(
  base: SelectQueryBuilder<Event>,
): Promise<EventFacetGroupCounts<GatheringFamily>> {
  const grouped = await countGroupedFacet(base, FAMILY_FACET_KEY_SQL);
  const options = Object.fromEntries(
    GATHERING_FAMILY_VALUES.map((family) => [
      family,
      grouped.options[family] ?? 0,
    ]),
  ) as Record<GatheringFamily, number>;
  return { options, all: grouped.all };
}

/** Neighbourhood counts, keyed by the lowercased stored name. */
export function countHoodFacets(
  base: SelectQueryBuilder<Event>,
): Promise<EventFacetGroupCounts<string>> {
  return countGroupedFacet(base, HOOD_FACET_KEY_SQL);
}

/** Format counts, keyed by the lowercased stored format. */
export function countTypeFacets(
  base: SelectQueryBuilder<Event>,
): Promise<EventFacetGroupCounts<string>> {
  return countGroupedFacet(base, TYPE_FACET_KEY_SQL);
}

/** Splits `countByFilterClauses`' flat map into the options and the total. */
function splitAll<Option extends string>(
  counts: Record<string, number>,
  options: readonly Option[],
): EventFacetGroupCounts<Option> {
  const optionCounts: Partial<Record<Option, number>> = {};
  for (const option of options) optionCounts[option] = counts[option] ?? 0;
  return { options: optionCounts, all: counts[ALL_OPTION] ?? 0 };
}

/**
 * Date counts over a base with `when` lifted, one `COUNT(*) FILTER` per sent
 * window. The windows overlap ("Next 7 days" holds "Today"), so each is
 * counted on its own and `all` is a count of its own. Each window binds its
 * two bounds under its own names before the scan; the per-option parameter
 * `countByFilterClauses` sets is unused here.
 *
 * Mutates the builder it is handed, so pass a fresh one.
 */
export async function countWhenFacets(
  base: SelectQueryBuilder<Event>,
  windows: readonly EventWhenWindow[],
): Promise<EventFacetGroupCounts<EventWhenFacetKey>> {
  const boundsByKey = new Map<string, { fromParam: string; toParam: string }>();
  for (const window of windows) {
    const fromParam = `whenFacetFrom_${window.key}`;
    const toParam = `whenFacetTo_${window.key}`;
    base.setParameter(fromParam, window.from).setParameter(toParam, window.to);
    boundsByKey.set(window.key, { fromParam, toParam });
  }
  const windowKeys = windows.map((window) => window.key);
  const counts = await countByFilterClauses(
    base,
    [...windowKeys, ALL_OPTION],
    (_param, option) => {
      const bounds = boundsByKey.get(option);
      if (!bounds) return 'TRUE';
      return `${discoveryFromSql(bounds.fromParam)} AND ${discoveryToSql(bounds.toParam)}`;
    },
    () => null,
  );
  return splitAll(counts, windowKeys);
}

/**
 * Cost counts over a base with `cost` lifted. Free and paid partition the
 * rows today (no cost reads as free), and `all` is still counted directly,
 * so "Any cost" keeps its own honest number if that ever changes.
 *
 * Mutates the builder it is handed, so pass a fresh one.
 */
export async function countCostFacets(
  base: SelectQueryBuilder<Event>,
  freeCostLabels: readonly string[],
): Promise<EventFacetGroupCounts<EventCostFilter>> {
  base.setParameter('freeCostLabels', freeCostLabels);
  const costOptions: readonly EventCostFilter[] = ['free', 'paid'];
  const counts = await countByFilterClauses(
    base,
    [...costOptions, ALL_OPTION],
    (_param, option) =>
      option === 'free'
        ? FREE_COST_SQL
        : option === 'paid'
          ? PAID_COST_SQL
          : 'TRUE',
    () => null,
  );
  return splitAll(counts, costOptions);
}
