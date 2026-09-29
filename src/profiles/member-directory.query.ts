import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import {
  AMBASSADOR_FOCUS_AREAS,
  isAmbassadorFocusArea,
} from '../ambassadors/ambassador-focus-areas';
import {
  NOT_BADGED_STAFF_PARAMETERS,
  notBadgedStaffClause,
} from '../ambassadors/ambassador-status.service';
import { countByFilterClauses } from '../common/facet-counts';
import { escapeLikeTerm } from '../common/like-escape';
import {
  PROFILE_PUBLIC_SEARCH_COLUMNS,
  PROFILE_PUBLIC_SEARCH_FIELDS,
  PROFILE_SEARCH_COLUMNS,
  PROFILE_SEARCH_FIELDS,
  foldedHaystack,
  foldedSearchQuery,
  foldedSearchTerm,
  searchRankExpression,
  weightedSearchVector,
  type WeightedSearchField,
} from '../search/search-text';
import { ProfileVisibility } from '../users/entities/profile.entity';
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
  LISTED_DISCIPLINE_IDS,
  LISTED_PROFESSION_IDS,
  listedDisciplines,
  listedProfessions,
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
  | 'languages'
  | 'ambassador';

export interface DirectoryFacetCounts {
  openTo: Record<string, number>;
  hoods: Record<string, number>;
  identities: Record<string, number>;
  disciplines: Record<string, number>;
  professions: Record<string, number>;
  languages: Record<string, number>;
  /** One count per focus-area key, each assuming `ambassador=1`: "how many
   *  visible ambassadors would I get if I also picked this focus area". */
  ambassador: Record<string, number>;
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

/** Every option of every counted group, zeroed. The count queries overwrite the
 *  entries they find; whatever they never mention stays a truthful `0`.
 *
 *  Disciplines and professions are zeroed over the LISTED sets only, so
 *  `adultWork`/`sexWorker` and its five siblings never get a key at all
 *  here, no matter what the count queries below would otherwise find. See
 *  `professions.ts#UNLISTED_DISCIPLINE_IDS`. */
export function zeroedFacetCounts(): DirectoryFacetCounts {
  const zero = (ids: readonly string[]): Record<string, number> =>
    Object.fromEntries(ids.map((id) => [id, 0]));
  return {
    openTo: zero(OPEN_TO_PRESET_IDS),
    identities: zero(DIRECTORY_IDENTITY_FACETS),
    disciplines: zero(LISTED_DISCIPLINE_IDS),
    professions: zero(LISTED_PROFESSION_IDS),
    languages: zero(LANGUAGE_CODES),
    hoods: zero(HOOD_FACET_IDS),
    ambassador: zero(AMBASSADOR_FOCUS_AREAS),
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
 * An `open` profile: the tier whose card shows what the limited card hides.
 * A literal enum value in place of a bound parameter, so the clauses built on
 * it also work inside the `addSelect` expressions `searchMembers` builds.
 */
const OPEN_PROFILE_CLAUSE = `"p"."visibility" = '${ProfileVisibility.Open}'`;

/**
 * Rows whose bio a directory viewer may read, and so may be searched and
 * ranked on (ENG-438). The same `open` gate `toMemberCard` applies before it
 * borrows a bio for the card blurb: a `network`/`private` member's bio sits
 * behind the limited card.
 */
export const BIO_SEARCHABLE_CLAUSE = OPEN_PROFILE_CLAUSE;

/**
 * Rows whose neighbourhood a directory viewer may see (ENG-439): the same
 * two-layer gate `toMemberCard` applies to `location`/`hood` for a non-owner
 * (the profile is `open` AND the member left `hoodVisible` on). Both the
 * "Where they're based" filter and its counts sit behind it, so a hidden
 * location neither matches nor counts.
 */
export const HOOD_VISIBLE_CLAUSE = `(${OPEN_PROFILE_CLAUSE} AND "p"."hood_visible" = true)`;

/** The full-text OR substring match over one field list. */
function textMatchOver(
  fields: WeightedSearchField[],
  columns: readonly string[],
): string {
  return (
    `${weightedSearchVector('p', fields)} @@ ${foldedSearchQuery('memberSearchTerm')} ` +
    `OR ${foldedHaystack('p', [...columns])} LIKE ${foldedSearchTerm('memberSearchPattern')}`
  );
}

/**
 * The name/bio half of the member search predicate: the weighted full-text
 * match OR the folded substring match. The whole expression is an OR of
 * parenthesised branches, so the caller can OR further branches into the
 * same group. Binds `:memberSearchTerm` and `:memberSearchPattern`, which
 * `applyDirectoryFilters` sets.
 *
 * Bio-gated (ENG-438): a row whose bio the viewer may read matches over every
 * profile field, and any other row matches over the fields minus the bios.
 * Written as two exclusive branches. The shorter "matches everywhere AND
 * (bio readable OR matches without the bio)" leaks: `websearch_to_tsquery`
 * accepts a negated word, so "ana -word" would drop exactly the private Anas
 * whose hidden bio says "word". The first branch keeps the
 * index-backed expressions from `1795100000000-AddSearchTextIndexes`
 * verbatim. The second branch is backed by the partial indexes in
 * `1824900000000-AddProfilePublicSearchIndexes` (`WHERE "visibility" <>
 * 'open'`), so both OR arms have an index path and Postgres can BitmapOr
 * them. Keep the second branch's gate a literal `NOT "p"."visibility" =
 * 'open'`: the planner proves the partial predicate from it, and a bound
 * parameter or a reworded gate could drop that proof and bring back the
 * sequential scan. The spec pins it.
 *
 * Exported so `searchMembers` can order text hits ahead of hits that came
 * only through a profession or field of work, using the very expression the
 * filter applied.
 */
export function memberSearchTextMatch(): string {
  return (
    `(${BIO_SEARCHABLE_CLAUSE} AND (${textMatchOver(PROFILE_SEARCH_FIELDS, PROFILE_SEARCH_COLUMNS)})) ` +
    `OR (NOT ${BIO_SEARCHABLE_CLAUSE} AND (${textMatchOver(PROFILE_PUBLIC_SEARCH_FIELDS, PROFILE_PUBLIC_SEARCH_COLUMNS)}))`
  );
}

/**
 * The relevance score for the directory's default search ordering, gated
 * exactly like `memberSearchTextMatch`: a hidden bio must not lift a row's
 * rank any more than it may make the row match. Binds `:memberSearchTerm`
 * only. For `searchMembers`' `member_search_rank` select, in place of a
 * `searchRankExpression` built over the full profile field list.
 */
export function memberSearchRank(): string {
  const tsQuery = foldedSearchQuery('memberSearchTerm');
  const foldedTerm = foldedSearchTerm('memberSearchTerm');
  const fullRank = searchRankExpression(
    weightedSearchVector('p', PROFILE_SEARCH_FIELDS),
    tsQuery,
    foldedHaystack('p', PROFILE_SEARCH_COLUMNS),
    foldedTerm,
  );
  const publicRank = searchRankExpression(
    weightedSearchVector('p', PROFILE_PUBLIC_SEARCH_FIELDS),
    tsQuery,
    foldedHaystack('p', PROFILE_PUBLIC_SEARCH_COLUMNS),
    foldedTerm,
  );
  return `(CASE WHEN ${BIO_SEARCHABLE_CLAUSE} THEN ${fullRank} ELSE ${publicRank} END)`;
}

/**
 * The profession and discipline ids the frontend resolved from the search
 * words, range-checked against the catalogs. Both lists are empty whenever
 * there is no `query`: the ids are part of the search term and mean nothing
 * on their own.
 */
export function memberSearchIds(q: ListMembersQuery): {
  searchProfessions: string[];
  searchDisciplines: string[];
} {
  if (!q.query) return { searchProfessions: [], searchDisciplines: [] };
  return {
    // Built from `listed*`: an unlisted id (sex work & adult content) must
    // never widen a search, or a query that resolved to `sexWorker` would
    // surface exactly the members that field exists to keep unfindable.
    // See professions.ts#UNLISTED_DISCIPLINE_IDS.
    searchProfessions: listedProfessions(csv(q.searchProfessions)),
    searchDisciplines: listedDisciplines(csv(q.searchDisciplines)),
  };
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
  // Free-text search (SOC-08). Up to three branches, OR'd:
  //
  //  - an accent-folded full-text match, so "Sao" finds "São" and a hit in a
  //    name outranks one in a bio (the weights live in `PROFILE_SEARCH_FIELDS`);
  //  - the original substring match, folded the same way. Kept because full
  //    text matches whole tokens: dropping it would stop "trans" finding
  //    "transfeminine", a regression on what members already rely on.
  //  - a profession or field of work, so "nurse" or "enfermeira" finds the
  //    members who picked Nurse even when their bio never says so. This one
  //    is an array overlap on `profiles.profession` / `profiles.discipline`
  //    against ids the CLIENT sends as `searchProfessions` /
  //    `searchDisciplines`. The labels live in the frontend catalogs in EN and
  //    PT and the server stores ids only, so the frontend is the side that can
  //    turn typed words into ids. It mirrors the persona directory's kind
  //    search (src/subprofiles/subprofile-kind-search.ts, used by
  //    `subprofile-public-read.service.ts`), with the word-to-id step moved
  //    client-side. Unknown ids are dropped, and a list that ends up empty
  //    adds no branch at all, so the SQL never binds an empty array. The
  //    parameter names are distinct from the chip filters' `:professions` /
  //    `:disciplines` below, which stay exact AND filters in the same builder.
  //
  // The haystack includes `bio` and `bio_pt`. `bio_pt` matters most: a
  // Portuguese-speaking member writes their real self-description there.
  // Both are searched only on `open` profiles (ENG-438); see
  // `memberSearchTextMatch`.
  //
  // Not a facet group and so never skipped: a count is "how many of MY current
  // results", and the search term is part of what makes them the member's.
  // The profession and discipline ids ride along for the same reason: they
  // are the search term, read as a profession.
  if (q.query) {
    // Escape LIKE metacharacters (\ % _) so a user-supplied term is matched
    // literally and can't inject wildcards. Postgres treats backslash as the
    // default LIKE escape character.
    const term = `%${escapeLikeTerm(q.query)}%`;
    const { searchProfessions, searchDisciplines } = memberSearchIds(q);
    // Every arm of this OR needs an index path or the group seq-scans:
    // the text arms use the search indexes, and the `&&` arms below use the
    // GIN indexes on `profession` / `discipline` from
    // `1824910000000-AddProfileProfessionDisciplineGinIndexes`.
    const searchBranches = [memberSearchTextMatch()];
    const searchParameters: Record<string, unknown> = {
      memberSearchTerm: q.query,
      memberSearchPattern: term,
    };
    if (searchProfessions.length) {
      searchBranches.push('p.profession && :memberSearchProfessions');
      searchParameters.memberSearchProfessions = searchProfessions;
    }
    if (searchDisciplines.length) {
      searchBranches.push('p.discipline && :memberSearchDisciplines');
      searchParameters.memberSearchDisciplines = searchDisciplines;
    }
    qb.andWhere(`(${searchBranches.join(' OR ')})`, searchParameters);
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
  //
  // Gated by `HOOD_VISIBLE_CLAUSE` (ENG-439), the card's own location gate:
  // a member whose card hides their neighbourhood (not `open`, or
  // `hoodVisible` off) never matches a neighbourhood. Without it, ticking one
  // neighbourhood at a time would sort the members who hid theirs into it.
  if (skip !== 'hoods') {
    const hoods = knownNeighbourhoods(csv(q.hoods));
    if (csv(q.hoods).length) {
      if (!hoods.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere(
          `(${HOOD_VISIBLE_CLAUSE} AND (` +
            hoods.map((_, i) => `p.location ILIKE :hood${i}`).join(' OR ') +
            '))',
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
  //
  // Built from `listed*`: `adultWork`/`sexWorker` and its siblings are
  // selectable but stay unfindable (see
  // professions.ts#UNLISTED_DISCIPLINE_IDS), so a request naming only an
  // unlisted id takes the exact `1 = 0` path an UNKNOWN id takes below.
  // Nothing about the response tells the two apart.
  if (skip !== 'disciplines') {
    const disciplines = listedDisciplines(csv(q.disciplines));
    if (csv(q.disciplines).length) {
      if (!disciplines.length) {
        qb.andWhere('1 = 0');
      } else {
        qb.andWhere('p.discipline && :disciplines', { disciplines });
      }
    }
  }
  if (skip !== 'professions') {
    const professions = listedProfessions(csv(q.professions));
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

  // "Ambassadors" filter. `focus` narrows the same EXISTS and only means
  // anything alongside `ambassador=1`; sent alone it is ignored, matching the
  // design's "focus only applies alongside ambassador" rule. Unknown focus
  // keys are dropped, and the visible-tag gate keeps a member whose tag is
  // hidden out of the directory the same way it stays off the roster and the
  // invitee welcome line. Staff always win: a member wearing a staff badge is
  // never a visible ambassador here either (see `notBadgedStaffClause`).
  if (skip !== 'ambassador' && q.ambassador === '1') {
    const focusAreas = csv(q.focus).filter(isAmbassadorFocusArea);
    qb.andWhere(
      `p.is_ambassador_tag_visible = true AND EXISTS (
        SELECT 1 FROM "ambassadors" "amb"
        WHERE "amb"."user_id" = p.user_id AND "amb"."revoked_at" IS NULL
        ${focusAreas.length ? 'AND "amb"."focus_area" IN (:...ambassadorFocusAreas)' : ''}
      ) AND ${notBadgedStaffClause('"p"."user_id"')}`,
      {
        ...NOT_BADGED_STAFF_PARAMETERS,
        ...(focusAreas.length ? { ambassadorFocusAreas: focusAreas } : {}),
      },
    );
  }
}

/**
 * Availability counts for every counted group.
 *
 * `base(skip)` must return a FRESH query builder each call — carrying the
 * viewer's visibility gates and `applyDirectoryFilters(qb, q, skip)` — because
 * each of these seven queries mutates the builder it is handed.
 *
 * The seven run concurrently. They are seven extra round trips per directory
 * request; at this directory's size that is cheaper than the alternatives
 * (grouping sets over seven different predicate sets, or a materialized facet
 * table that would go stale). If it ever stops being cheap, the escape hatch is
 * to have the sidebar ask for them only when it is open, rather than to make
 * the numbers less true.
 */
export async function countDirectoryFacets(
  base: (skip: DirectoryFacetGroup) => SelectQueryBuilder<ObjectLiteral>,
): Promise<DirectoryFacetCounts> {
  const [
    openTo,
    hoods,
    identities,
    disciplines,
    professions,
    languages,
    ambassador,
  ] = await Promise.all([
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
    //
    // Every real neighbourhood's clause carries `HOOD_VISIBLE_CLAUSE`, the
    // filter's own gate (ENG-439), so a hidden location adds to no count.
    // `All of Lisbon` stays ungated: it counts the whole hood-unrestricted
    // population, which says nothing about where anyone lives.
    countByFilterClauses(
      base('hoods'),
      HOOD_FACET_IDS,
      (param, option) =>
        option === ALL_OF_LISBON
          ? `COALESCE("p"."location", '') ILIKE :${param}`
          : `${HOOD_VISIBLE_CLAUSE} AND COALESCE("p"."location", '') ILIKE :${param}`,
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
    // LISTED ids only: iterating the full taxonomy here would hand
    // `adultWork`/`sexWorker` a facet-count key, which is a count (a way
    // to learn how many members are sex workers) exactly as much as a
    // chip filter is. See professions.ts#UNLISTED_DISCIPLINE_IDS.
    countByFilterClauses(
      base('disciplines'),
      LISTED_DISCIPLINE_IDS,
      (param) => `"p"."discipline" && :${param}`,
      (option) => [option],
    ),
    countByFilterClauses(
      base('professions'),
      LISTED_PROFESSION_IDS,
      (param) => `"p"."profession" && :${param}`,
      (option) => [option],
    ),
    countByFilterClauses(
      base('languages'),
      LANGUAGE_CODES,
      (param) => `"p"."languages" && :${param}`,
      (option) => [option],
    ),
    // One count per focus area, each assuming the visible-tag gate, the
    // active-ambassador EXISTS and the staff exclusion the filter itself
    // applies (see `applyDirectoryFilters`). It is the same predicate either
    // way, per this file's header. The staff parameters go on the builder
    // first, because `countByFilterClauses` binds only the per-option one.
    countByFilterClauses(
      base('ambassador').setParameters(NOT_BADGED_STAFF_PARAMETERS),
      AMBASSADOR_FOCUS_AREAS,
      (param) =>
        `"p"."is_ambassador_tag_visible" = true AND EXISTS (
            SELECT 1 FROM "ambassadors" "ambCount"
            WHERE "ambCount"."user_id" = "p"."user_id"
              AND "ambCount"."revoked_at" IS NULL
              AND "ambCount"."focus_area" = :${param}
          ) AND ${notBadgedStaffClause('"p"."user_id"')}`,
      (option) => option,
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
    ambassador,
  };
}
