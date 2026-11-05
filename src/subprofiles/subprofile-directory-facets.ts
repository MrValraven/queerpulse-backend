import { type EntityManager, type SelectQueryBuilder } from 'typeorm';
import { countByFilterClauses } from '../common/facet-counts';
import { Subprofile, SubprofileKind } from './entities/subprofile.entity';
import { SubprofileSection } from './entities/subprofile-item.entity';
import {
  bindRefinementParameters,
  tableFormatClause,
  tableVibesClause,
  tagsOverlapClause,
  type DirectoryFacetGroup,
} from './subprofile-directory-refinement';
import {
  TABLE_CHIP_FORMATS,
  TABLE_VIBES,
  type TableChipFormat,
  type TableVibe,
} from './subprofile-table-summary';
import { AVAILABILITY_KEYS } from './subprofile-validation';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';

/** How many of the directory's most-used tags the sidebar is offered. */
export const DIRECTORY_FACET_TAG_CAP = 20;

type AvailabilityKey = (typeof AVAILABILITY_KEYS)[number];

/**
 * The persona directory's facet block: for every sidebar option, how many
 * personas picking it would give, counted with that group's own predicate
 * lifted and every other group (plus the search term and the `kind` scope)
 * applied. Every map carries its full vocabulary, so an option nobody matches
 * reads as a real 0.
 *
 * - `kinds` and `availability` are scalar columns, so a `GROUP BY` counts each
 *   persona once.
 * - `tags` is ordered (most-used first) because it is also the sidebar's tag
 *   VOCABULARY: the directory's top tags over the whole visible directory,
 *   searched or not, plus any tag already picked so it can be undone.
 * - `tableFormats` counts with the format chips lifted. A `both` table counts
 *   under each chip, which is the same reading the filter gives.
 * - `tableVibes` is an AND group, so it counts under the vibes already picked:
 *   each number says what adding that vibe would leave.
 *
 * No group has an "All" option, so no group needs a distinct total; the grid's
 * own `total` is that answer.
 */
export interface SubprofileDirectoryFacets {
  kinds: Record<SubprofileKind, number>;
  tags: { tag: string; count: number }[];
  availability: Record<AvailabilityKey, number>;
  tableFormats: Record<TableChipFormat, number>;
  tableVibes: Record<TableVibe, number>;
}

export interface DirectoryFacetSources {
  /** A FRESH builder over the directory's base set (visibility, blocks,
   *  takedowns, `kind` scope, search) narrowed by every group except `lift`. */
  refinedBase: (lift?: DirectoryFacetGroup) => SelectQueryBuilder<Subprofile>;
  /** A FRESH builder over the visible directory alone, with no search and no
   *  refinement, which the tag vocabulary is drawn from. */
  visibleScope: () => SelectQueryBuilder<Subprofile>;
  manager: EntityManager;
  selectedTags: readonly string[];
}

/** One `GROUP BY` row. Postgres returns `COUNT(*)` as a bigint, which
 *  node-postgres hands back as a string. */
interface FacetCountRow {
  value: string | null;
  persona_count: string | number;
}

function fillFacetCounts<Option extends string>(
  options: readonly Option[],
  rows: FacetCountRow[],
): Record<Option, number> {
  const counts = Object.fromEntries(
    options.map((option) => [option, 0]),
  ) as Record<Option, number>;
  for (const row of rows) {
    if (row.value !== null && row.value in counts) {
      counts[row.value as Option] = Number(row.persona_count);
    }
  }
  return counts;
}

async function countByColumn<Option extends string>(
  qb: SelectQueryBuilder<Subprofile>,
  column: 'sp.kind' | 'sp.availability',
  options: readonly Option[],
): Promise<Record<Option, number>> {
  const rows = await qb
    .select(column, 'value')
    .addSelect('COUNT(*)', 'persona_count')
    .groupBy(column)
    .getRawMany<FacetCountRow>();
  return fillFacetCounts(options, rows);
}

/**
 * The most-used tags across the visible directory, most-used first, ties
 * alphabetical, with every picked tag appended. `unnest` fans each item out
 * into one row per tag; `DISTINCT` on (persona, tag) makes a persona count once
 * per tag however many of its items carry it. Postgres rejects a set-returning
 * function in `GROUP BY`, so the fan-out runs as a subquery.
 */
export function buildTagVocabularySql(
  scopeSql: string,
  linksSectionPlaceholder: string,
  visibleSectionsPlaceholder: string,
  capPlaceholder: string,
): string {
  return `SELECT "tag_entry"."tag" AS "tag", COUNT(*) AS "persona_count"
     FROM (
       SELECT DISTINCT "tag_item"."subprofile_id", unnest("tag_item"."tags") AS "tag"
       FROM "subprofile_items" "tag_item"
       INNER JOIN "subprofiles" "tag_persona" ON "tag_persona"."id" = "tag_item"."subprofile_id"
       WHERE "tag_item"."section" <> ${linksSectionPlaceholder}
         AND ${visibleSectionSql('"tag_item"."section"', '"tag_persona"."kind"', visibleSectionsPlaceholder)}
         AND "tag_item"."subprofile_id" IN (${scopeSql})
     ) "tag_entry"
     GROUP BY "tag_entry"."tag"
     ORDER BY "persona_count" DESC, "tag_entry"."tag" ASC
     LIMIT ${capPlaceholder}`;
}

async function loadTagVocabulary(
  sources: DirectoryFacetSources,
): Promise<string[]> {
  const [scopeSql, scopeParameters]: [string, unknown[]] = sources
    .visibleScope()
    .select('sp.id')
    .getQueryAndParameters();
  const sectionPosition = scopeParameters.length + 1;
  const visibleSectionsPosition = scopeParameters.length + 2;
  const capPosition = scopeParameters.length + 3;
  const rows = await sources.manager.query<{ tag: string }[]>(
    buildTagVocabularySql(
      scopeSql,
      `$${sectionPosition}`,
      `$${visibleSectionsPosition}`,
      `$${capPosition}`,
    ),
    [
      ...scopeParameters,
      SubprofileSection.Links,
      VISIBLE_SECTIONS_BY_KIND_JSON,
      DIRECTORY_FACET_TAG_CAP,
    ],
  );
  return [...new Set([...rows.map((row) => row.tag), ...sources.selectedTags])];
}

async function countTagFacets(
  sources: DirectoryFacetSources,
): Promise<{ tag: string; count: number }[]> {
  const vocabulary = await loadTagVocabulary(sources);
  const counts = await countByFilterClauses(
    sources.refinedBase('tags'),
    vocabulary,
    (param) => tagsOverlapClause(param),
    (tag) => [tag],
  );
  return vocabulary.map((tag) => ({ tag, count: counts[tag] ?? 0 }));
}

async function countTableFacets<Option extends string>(
  qb: SelectQueryBuilder<Subprofile>,
  options: readonly Option[],
  clause: (param: string) => string,
  parameterFor: (option: Option) => unknown,
): Promise<Record<Option, number>> {
  // The clauses lean on the Quest kinds list, bound here because the builder
  // may have had no table predicate of its own to bind it.
  bindRefinementParameters(qb);
  const counts = await countByFilterClauses(qb, options, clause, (option) =>
    parameterFor(option as Option),
  );
  // `countByFilterClauses` keys every option it was handed, so the record is
  // already complete.
  return counts;
}

/** Every facet group, one aggregate query each, run side by side. */
export async function countSubprofileDirectoryFacets(
  sources: DirectoryFacetSources,
): Promise<SubprofileDirectoryFacets> {
  const [kinds, availability, tags, tableFormats, tableVibes] =
    await Promise.all([
      countByColumn(
        sources.refinedBase('kinds'),
        'sp.kind',
        Object.values(SubprofileKind),
      ),
      countByColumn(
        sources.refinedBase('availability'),
        'sp.availability',
        AVAILABILITY_KEYS,
      ),
      countTagFacets(sources),
      countTableFacets(
        sources.refinedBase('tableFormats'),
        TABLE_CHIP_FORMATS,
        (param) => tableFormatClause(param),
        (format) => [format],
      ),
      countTableFacets(
        sources.refinedBase(),
        TABLE_VIBES,
        (param) => tableVibesClause(param),
        (vibe) => JSON.stringify([vibe]),
      ),
    ]);
  return { kinds, tags, availability, tableFormats, tableVibes };
}
