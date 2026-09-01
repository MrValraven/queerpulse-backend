import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { COMMUNITY_TAGS } from './community-tags';

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
