import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { escapeLikeTerm } from '../common/like-escape';
import {
  PROFILE_SEARCH_COLUMNS,
  PROFILE_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchQuery,
  foldedSearchTerm,
  weightedSearchVector,
} from '../search/search-text';
import { ListMembersQuery } from './dto/list-members.query';
import {
  DIRECTORY_IDENTITY_FACETS,
  FACET_LABELS,
  labelsForFacets,
  type DirectoryIdentityFacet,
} from './identities';
import { LANGUAGE_CODES, knownLanguages } from './languages';
import { NEIGHBOURHOODS, knownNeighbourhoods } from './neighbourhoods';
import { OPEN_TO_PRESET_IDS } from './open-to';
import {
  DISCIPLINE_BY_PROFESSION,
  DISCIPLINE_IDS,
  knownDisciplines,
  knownProfessions,
} from './professions';

/**
 * The member directory's WHERE clause, and the facet counts taken from it.
 *
 * ---------------------------------------------------------------------------
 * WHY THE PREDICATES LIVE HERE AND NOT INLINE IN `searchMembers`
 * ---------------------------------------------------------------------------
 * The sidebar shows a number beside every filter option ("Mentoring 7"). That
 * number is only true if it was counted over EXACTLY the population the results
 * grid is about to show — same blocks, same hidden-from, same search term, same
 * every-other-facet. A second, hand-copied set of predicates for the count
 * queries would drift from the first the day someone edits one of them, and the
 * failure is silent: the grid says 12 results, the badge says 9, and nothing
 * throws. So there is one function that applies the filters and both the page
 * query and the count queries call it.
 *
 * ---------------------------------------------------------------------------
 * WHAT A COUNT MEANS
 * ---------------------------------------------------------------------------
 * Availability, not population. Each group's count query drops ITS OWN
 * predicate and keeps every other one, so the number answers "how many of my
 * current results would I get if I ticked this". Keeping a group's own
 * predicate would zero out every unticked sibling the moment one was ticked
 * (an AND of two options in one group matches nobody), which reads as the
 * directory emptying rather than as a filter narrowing.
 *
 * Every known option gets an explicit entry, including `0`. A missing key means
 * "not counted", and the frontend renders nothing for it; a `0` means "counted,
 * and it is empty" and renders a dimmed, unclickable option. Collapsing the two
 * would make an unavailable option indistinguishable from an uncounted one.
 */

/** Which sidebar group a count is for — and, in `applyDirectoryFilters`, which
 *  predicate to leave out. */
export type DirectoryFacetGroup =
  | 'openTo'
  | 'hoods'
  | 'identities'
  | 'disciplines'
  | 'professions'
  | 'languages';

export interface DirectoryFacetCounts {
  openTo: Record<string, number>;
  hoods: Record<string, number>;
  identities: Record<string, number>;
  disciplines: Record<string, number>;
  professions: Record<string, number>;
  languages: Record<string, number>;
}

/** The frontend's "show every neighbourhood" row. It is chrome: the FE strips
 *  it from `?hoods=` before the request reaches the wire (see
 *  `useMemberDirectoryQuery`), so it never becomes a filter predicate. It
 *  exists here only because it is a row in the sidebar and every row carries a
 *  count, and its count is the whole hood-unrestricted population, which is
 *  exactly what ticking it returns. Kept out of `NEIGHBOURHOODS` so no filter
 *  path can ever treat it as a location. */
const ALL_OF_LISBON = 'All of Lisbon';

/** Every row of the "Where they're based" card, in sidebar order. */
const HOOD_FACET_IDS: readonly string[] = [...NEIGHBOURHOODS, ALL_OF_LISBON];

const PROFESSION_IDS = Object.keys(DISCIPLINE_BY_PROFESSION);

/** Every option of every counted group, zeroed. The count queries overwrite the
 *  entries they find; whatever they never mention stays a truthful `0`. */
export function zeroedFacetCounts(): DirectoryFacetCounts {
  const zero = (ids: readonly string[]): Record<string, number> =>
    Object.fromEntries(ids.map((id) => [id, 0]));
  return {
    openTo: zero(OPEN_TO_PRESET_IDS),
    identities: zero(DIRECTORY_IDENTITY_FACETS),
    disciplines: zero(DISCIPLINE_IDS),
    professions: zero(PROFESSION_IDS),
    languages: zero(LANGUAGE_CODES),
    hoods: zero(HOOD_FACET_IDS),
  };
}

/** Comma-separated query param -> trimmed, non-empty values. */
export function csv(raw: string | undefined): string[] {
  return raw
    ? raw
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];
}

/**
 * The "open to" membership test, as ONE expression used by both the filter and
 * the count clauses. `profiles.open_to` is jsonb (a preset/custom union, see
 * open-to.ts), not a plain array, so the `&&` overlap the array facets use does
 * not apply — an EXISTS over its unpacked elements does. Customs never
 * participate: they are the member's own words, not a searchable vocabulary.
 *
 * `many` picks `= ANY(:param)` (the filter, which ORs the member's selections)
 * over `= :param` (one count clause per preset id). Same predicate either way,
 * which is the point — see this file's header.
 */
function openToPresetExists(param: string, many: boolean): string {
  return `EXISTS (
     SELECT 1 FROM jsonb_array_elements("p"."open_to") elem
     WHERE elem->>'kind' = 'preset' AND elem->>'id' ${
       many ? `= ANY(:${param})` : `= :${param}`
     }
   )`;
}

/**
 * Applies every directory facet predicate to `qb`, which must already be
 * aliased `p` over `Profile` and carry its own visibility gates (the active-user
 * join, blocks, hidden-from, self-hide) — those are viewer-relative and need
 * injected services, so they stay with the caller.
 *
 * `skip` leaves one group's predicate out, for that group's count query.
 *
 * Every group follows the same "unknown id -> match nothing" rule: a caller who
 * asked for a facet that cannot exist gets an empty result, never the
 * unfiltered directory, which would be a silently wrong answer.
 */
export function applyDirectoryFilters<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  q: ListMembersQuery,
  skip?: DirectoryFacetGroup,
): void {
  // Free-text search (SOC-08). Two branches, OR'd:
  //
  //  - an accent-folded full-text match, so "Sao" finds "São" and a hit in a
  //    name outranks one in a bio (the weights live in `PROFILE_SEARCH_FIELDS`);
  //  - the original substring match, folded the same way. Kept because full
  //    text matches whole tokens: dropping it would stop "trans" finding
  //    "transfeminine", a regression on what members already rely on.
  //
  // The haystack includes `bio` and `bio_pt`. `bio_pt` matters most: a
  // Portuguese-speaking member writes their real self-description there.
  //
  // Not a facet group and so never skipped: a count is "how many of MY current
  // results", and the search term is part of what makes them the member's.
  if (q.query) {
    // Escape LIKE metacharacters (\ % _) so a user-supplied term is matched
    // literally and can't inject wildcards. Postgres treats backslash as the
    // default LIKE escape character.
    const term = `%${escapeLikeTerm(q.query)}%`;
    qb.andWhere(
      `(${weightedSearchVector('p', PROFILE_SEARCH_FIELDS)} @@ ${foldedSearchQuery('memberSearchTerm')} ` +
        `OR ${foldedHaystack('p', PROFILE_SEARCH_COLUMNS)} LIKE ${foldedSearchTerm('memberSearchPattern')})`,
      { memberSearchTerm: q.query, memberSearchPattern: term },
    );
  }

  const tags = csv(q.tags);
  if (tags.length) {
    qb.andWhere('p.tags && :tags', { tags });
  }

  // Identity filter. Reads `discoverable_identities` — the subset each member
  // OPTED IN to publishing — and never `identities`, which is private (see the
  // entity, and AddDiscoverableIdentities1782800770000 for why pointing this
  // at `identities` would be a special-category-data leak).
  //
  // The query param carries the directory's coarse facet ids (`transNonBinary`),
  // the column stores the member's own interest labels ('Trans', 'Genderfluid',
  // …), so facets expand to their label sets here.
  if (skip !== 'identities') {
    const facets = csv(q.identities);
    if (facets.length) {
      const identityLabels = labelsForFacets(facets);
      if (!identityLabels.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.discoverable_identities && :identityLabels', {
          identityLabels,
        });
      }
    }
  }

  if (skip !== 'openTo') {
    const requestedOpenTo = csv(q.openTo);
    const openToIds = requestedOpenTo.filter((id) =>
      (OPEN_TO_PRESET_IDS as readonly string[]).includes(id),
    );
    if (requestedOpenTo.length) {
      if (!openToIds.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(openToPresetExists('openToIds', true), { openToIds });
      }
    }
  }

  // "Where they're based" filter. `profiles.location` is free text, so a
  // neighbourhood "match" is the same substring test `matchNeighbourhood` uses
  // for the card's `hood` field — filtering and display can't drift apart
  // because they share one function.
  if (skip !== 'hoods') {
    const hoods = knownNeighbourhoods(csv(q.hoods));
    if (csv(q.hoods).length) {
      if (!hoods.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(
          '(' +
            hoods.map((_, i) => `p.location ILIKE :hood${i}`).join(' OR ') +
            ')',
          Object.fromEntries(hoods.map((h, i) => [`hood${i}`, `%${h}%`])),
        );
      }
    }
  }

  // "What they do" / "Profession" filters. Plain array-overlap, same shape as
  // `tags` above. See src/profiles/professions.ts.
  //
  // The two are skipped INDEPENDENTLY, not as one "what they do" group: a
  // discipline count drops only the discipline predicate and keeps the
  // profession one, and vice versa. That is what makes each number answer for
  // its own checkbox rather than for its neighbour's.
  if (skip !== 'disciplines') {
    const disciplines = knownDisciplines(csv(q.disciplines));
    if (csv(q.disciplines).length) {
      if (!disciplines.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.discipline && :disciplines', { disciplines });
      }
    }
  }
  if (skip !== 'professions') {
    const professions = knownProfessions(csv(q.professions));
    if (csv(q.professions).length) {
      if (!professions.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.profession && :professions', { professions });
      }
    }
  }

  // Languages filter. Plain array-overlap, same shape as `tags`.
  if (skip !== 'languages') {
    const languages = knownLanguages(csv(q.languages));
    if (csv(q.languages).length) {
      if (!languages.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.languages && :languages', { languages });
      }
    }
  }

  // Member age (tenure) filter — years since joined, computed from
  // `profiles.joined_at`. Either bound may be sent alone. Never skipped: the
  // age range carries no counts (it is a numeric range, not a set of options).
  if (q.yearsFrom !== undefined) {
    qb.andWhere(`date_part('year', age(now(), p.joined_at)) >= :yearsFrom`, {
      yearsFrom: q.yearsFrom,
    });
  }
  if (q.yearsTo !== undefined) {
    qb.andWhere(`date_part('year', age(now(), p.joined_at)) <= :yearsTo`, {
      yearsTo: q.yearsTo,
    });
  }
}

/**
 * Availability counts for every counted group.
 *
 * `base(skip)` must return a FRESH query builder each call — carrying the
 * viewer's visibility gates and `applyDirectoryFilters(qb, q, skip)` — because
 * each of these six queries mutates the builder it is handed.
 *
 * The six run concurrently. They are six extra round trips per directory
 * request; at this directory's size that is cheaper than the alternatives
 * (grouping sets over six different predicate sets, or a materialized facet
 * table that would go stale). If it ever stops being cheap, the escape hatch is
 * to have the sidebar ask for them only when it is open, rather than to make
 * the numbers less true.
 */
export async function countDirectoryFacets(
  base: (skip: DirectoryFacetGroup) => SelectQueryBuilder<ObjectLiteral>,
): Promise<DirectoryFacetCounts> {
  const [openTo, hoods, identities, disciplines, professions, languages] =
    await Promise.all([
      countByFilterClauses(
        base('openTo'),
        OPEN_TO_PRESET_IDS,
        (param) => openToPresetExists(param, false),
        (option) => option,
      ),
      // Neighbourhoods are the one group that matches by substring over
      // free-text `location` rather than by set overlap, so their count clause
      // is the same `ILIKE` the filter uses. `All of Lisbon` is the "no hood
      // restriction" row, so it binds the pattern that matches everyone, and
      // the COALESCE is what makes that true of members who never wrote a
      // location at all (`NULL ILIKE '%'` is NULL, which would quietly
      // undercount exactly the members that row promises to include).
      countByFilterClauses(
        base('hoods'),
        HOOD_FACET_IDS,
        (param) => `COALESCE("p"."location", '') ILIKE :${param}`,
        (option) => (option === ALL_OF_LISBON ? '%' : `%${option}%`),
      ),
      // Identities count per FACET, not per stored label, and so cannot use the
      // array-unnest shape the plain-array groups could: a member holding both
      // 'Trans' and 'Genderfluid' answers the single "Trans & non-binary"
      // checkbox once, and grouping by label would count them twice.
      countByFilterClauses(
        base('identities'),
        DIRECTORY_IDENTITY_FACETS,
        (param) => `"p"."discoverable_identities" && :${param}`,
        (option) => FACET_LABELS[option as DirectoryIdentityFacet],
      ),
      countByFilterClauses(
        base('disciplines'),
        DISCIPLINE_IDS,
        (param) => `"p"."discipline" && :${param}`,
        (option) => [option],
      ),
      countByFilterClauses(
        base('professions'),
        PROFESSION_IDS,
        (param) => `"p"."profession" && :${param}`,
        (option) => [option],
      ),
      countByFilterClauses(
        base('languages'),
        LANGUAGE_CODES,
        (param) => `"p"."languages" && :${param}`,
        (option) => [option],
      ),
    ]);
  return {
    ...zeroedFacetCounts(),
    openTo,
    hoods,
    identities,
    disciplines,
    professions,
    languages,
  };
}
