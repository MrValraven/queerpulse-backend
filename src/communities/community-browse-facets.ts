import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { COMMUNITY_TAGS } from './community-tags';
import { AccessTier } from './entities/community.entity';

/**
 * Per-tag availability counts for the communities browse, over the base query
 * with the tag filter itself lifted (`CommunitiesService.browseBaseQuery`'s
 * `skip`). So a number answers "how many would I get if I picked this tag,
 * given the search, category and toggles already applied" — which is the only
 * reading under which a 0 may grey the chip out. Its own predicate left in
 * would make every unselected tag count 0 the moment any tag was picked.
 *
 * Every id in the taxonomy comes back, zeros included: a tag nobody carries is
 * a real answer, and the tray shows it dimmed rather than dropping it (an
 * option that disappears makes the vocabulary feel unstable). The array
 * overlap is the same `&&` the filter itself uses against the GIN-indexed
 * `communities.tags`, so a chip can never promise a count the filter then
 * disagrees with.
 *
 * Mutates the builder it is handed — pass a fresh one.
 */
export async function countCommunityTagFacets(
  base: SelectQueryBuilder<ObjectLiteral>,
): Promise<Record<string, number>> {
  return countByFilterClauses(
    base,
    COMMUNITY_TAGS,
    (param) => `"c"."tags" && :${param}`,
    (option) => [option],
  );
}

/**
 * A community reads as "busy this week" at or above this many active members
 * (`communities.active_this_week`, refreshed hourly by
 * `CommunityActivityCounterService`). The frontend keeps the same number in
 * `communitiesDiscover.data.ts` for its offline demo registry ONLY — live mode
 * never re-applies the cut client-side, so the two can differ without the
 * product disagreeing with itself, and this file is the authority.
 */
export const BUSY_THRESHOLD = 15;

/** The two scalar browse toggles, as facet keys. */
type ToggleFacet = 'openToAll' | 'busy';
const TOGGLE_FACETS: ToggleFacet[] = ['openToAll', 'busy'];

/**
 * Availability counts for the browse's two pill toggles — "Open to all" and
 * "Busy this week" — in ONE aggregate scan.
 *
 * Each must be counted under every other filter with its OWN predicate lifted,
 * or a toggle that is on would read back its own result set instead of
 * answering "how many are there?". So the base query is handed in with BOTH
 * lifted (`browseBaseQuery`'s `skip: 'toggles'`) and each count re-applies the
 * OTHER one inline. That is why this is not two calls: two lifted bases would
 * otherwise mean two scans of the same table for two numbers.
 *
 * Mutates the builder it is handed — pass a fresh one.
 */
export async function countCommunityToggleFacets(
  base: SelectQueryBuilder<ObjectLiteral>,
  query: { access?: AccessTier; busy?: boolean },
): Promise<{ openToAll: number; busy: number }> {
  // The lifted-back tails. An absent filter contributes nothing, so a browse
  // with neither toggle on counts both over the plain base.
  const busyTail = query.busy
    ? ` AND "c"."active_this_week" >= :facetBusyThreshold`
    : '';
  const accessTail = query.access
    ? ` AND "c"."access_tier" = :facetAccessTier`
    : '';
  base.setParameter('facetBusyThreshold', BUSY_THRESHOLD);
  base.setParameter('facetAccessTier', query.access ?? AccessTier.Public);

  const counts = await countByFilterClauses(
    base,
    TOGGLE_FACETS,
    (param, option) =>
      option === 'openToAll'
        ? `"c"."access_tier" = :${param}${busyTail}`
        : `"c"."active_this_week" >= :${param}${accessTail}`,
    (option) => (option === 'openToAll' ? AccessTier.Public : BUSY_THRESHOLD),
  );
  return { openToAll: counts.openToAll ?? 0, busy: counts.busy ?? 0 };
}
