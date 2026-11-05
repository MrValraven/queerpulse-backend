import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';
import type { ListSubprofileDirectoryQuery } from './dto/list-directory.query';
import type { SubprofileKind } from './entities/subprofile.entity';
import { SubprofileSection } from './entities/subprofile-item.entity';
import {
  VISIBLE_SECTIONS_BY_KIND_JSON,
  VISIBLE_SECTIONS_PARAMETER,
  visibleSectionSql,
} from './subprofile-visible-sections-sql';
import {
  QUEST_KINDS,
  type TableChipFormat,
  type TableVibe,
} from './subprofile-table-summary';

/**
 * The persona directory's sidebar filters as SQL, kept apart from
 * `SubprofilePublicReadService.directory` so each facet count can be taken
 * with its OWN group lifted and every other group applied.
 *
 * Every predicate here mirrors a browser-side one the frontend used to run over
 * the pages it had loaded (`subprofileDirectoryFacets.ts`), so moving them onto
 * the server changed the reach of each filter (the whole table) and nothing
 * about what it matches:
 * - professions OR (`sp.kind IN`),
 * - tags OR, read off the persona's non-links items, which is where the card's
 *   tag row comes from (`loadContentTagsFor`),
 * - availability is one stored key,
 * - "At the table" formats OR (a stored `both` matches either chip) and vibes
 *   AND, read from the Quest personas' `skin_data -> 'atTheTable'` block only,
 *   since `toCardTableSummary` gives no other kind a table.
 */
export type DirectoryFacetGroup =
  'kinds' | 'tags' | 'availability' | 'tableFormats' | 'tableVibes';

export interface DirectoryRefinement {
  kinds: SubprofileKind[];
  tags: string[];
  availability: string | null;
  tableFormats: TableChipFormat[];
  tableVibes: TableVibe[];
}

/** The refinement a request asks for, deduped. `kind` (the single-profession
 *  scope) is deliberately not here: it belongs to the base set. */
export function toDirectoryRefinement(
  query: ListSubprofileDirectoryQuery,
): DirectoryRefinement {
  return {
    kinds: [...new Set(query.kinds ?? [])],
    tags: [...new Set(query.tags ?? [])],
    availability: query.availability ?? null,
    tableFormats: [...new Set(query.tableFormats ?? [])],
    tableVibes: [...new Set(query.tableVibes ?? [])],
  };
}

// The Quest persona's "At the table" block. `skin_data` has no server-side
// schema, so each clause also checks the shape it reads (`->>` on a non-object
// is NULL, and `@>` on a non-array never holds).
const TABLE_BLOCK = `"sp"."skin_data" -> 'atTheTable'`;
const TABLE_FORMAT = `(${TABLE_BLOCK} ->> 'format')`;
const TABLE_VIBES_ARRAY = `(${TABLE_BLOCK} -> 'vibe')`;
const IS_QUEST_PERSONA = `"sp"."kind" IN (:...tableQuestKinds)`;

/** A persona whose non-links items, in sections its kind shows, carry any of
 *  the tags bound to `param` (a text array). Needs `tagLinksSection` and
 *  `visibleSectionsByKind` bound. */
export function tagsOverlapClause(param: string): string {
  return `EXISTS (
    SELECT 1 FROM "subprofile_items" "tag_item"
    WHERE "tag_item"."subprofile_id" = "sp"."id"
      AND "tag_item"."section" <> :tagLinksSection
      AND ${visibleSectionSql('"tag_item"."section"', '"sp"."kind"')}
      AND "tag_item"."tags" && :${param}
  )`;
}

/** A Quest table run in any of the formats bound to `param` (a list), where a
 *  `both` table answers every format. Needs `tableQuestKinds` bound. */
export function tableFormatClause(param: string): string {
  return (
    `(${IS_QUEST_PERSONA} AND (${TABLE_FORMAT} = 'both' OR ` +
    `${TABLE_FORMAT} IN (:...${param})))`
  );
}

/** A Quest table carrying every vibe in the JSON array bound to `param`.
 *  Needs `tableQuestKinds` bound. */
export function tableVibesClause(param: string): string {
  return (
    `(${IS_QUEST_PERSONA} AND jsonb_typeof(${TABLE_VIBES_ARRAY}) = 'array' ` +
    `AND ${TABLE_VIBES_ARRAY} @> CAST(:${param} AS jsonb))`
  );
}

/** Binds the parameters the clauses above lean on, so a facet count can use
 *  them on a builder whose own group was lifted. */
export function bindRefinementParameters<Entity extends ObjectLiteral>(
  qb: SelectQueryBuilder<Entity>,
): void {
  qb.setParameter('tagLinksSection', SubprofileSection.Links);
  qb.setParameter('tableQuestKinds', [...QUEST_KINDS]);
  qb.setParameter(VISIBLE_SECTIONS_PARAMETER, VISIBLE_SECTIONS_BY_KIND_JSON);
}

/**
 * Narrows `qb` (aliased `sp`) by every group in `refinement` except `lift`.
 * Lifting a group is what makes its count answer "how many would picking this
 * give, under everything else already narrowed".
 */
export function applyDirectoryRefinement<Entity extends ObjectLiteral>(
  qb: SelectQueryBuilder<Entity>,
  refinement: DirectoryRefinement,
  lift?: DirectoryFacetGroup,
): void {
  bindRefinementParameters(qb);
  if (lift !== 'kinds' && refinement.kinds.length > 0) {
    qb.andWhere('sp.kind IN (:...refineKinds)', {
      refineKinds: refinement.kinds,
    });
  }
  if (lift !== 'tags' && refinement.tags.length > 0) {
    qb.andWhere(tagsOverlapClause('refineTags'), {
      refineTags: refinement.tags,
    });
  }
  if (lift !== 'availability' && refinement.availability !== null) {
    qb.andWhere('sp.availability = :refineAvailability', {
      refineAvailability: refinement.availability,
    });
  }
  if (lift !== 'tableFormats' && refinement.tableFormats.length > 0) {
    qb.andWhere(tableFormatClause('refineTableFormats'), {
      refineTableFormats: refinement.tableFormats,
    });
  }
  if (lift !== 'tableVibes' && refinement.tableVibes.length > 0) {
    qb.andWhere(tableVibesClause('refineTableVibes'), {
      refineTableVibes: JSON.stringify(refinement.tableVibes),
    });
  }
}
