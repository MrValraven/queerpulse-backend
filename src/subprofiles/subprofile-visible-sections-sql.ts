import { KIND_SECTIONS } from './subprofile-kinds';

/** Named query parameter that carries VISIBLE_SECTIONS_BY_KIND_JSON. */
export const VISIBLE_SECTIONS_PARAMETER = 'visibleSectionsByKind';

/**
 * JSON object of kind -> the sections that show for that kind: its own
 * sections plus the universal `gallery` and `links`. Built once at load.
 */
export const VISIBLE_SECTIONS_BY_KIND_JSON: string = JSON.stringify(
  Object.fromEntries(
    Object.entries(KIND_SECTIONS).map(([kind, sections]) => [
      kind,
      [...sections, 'gallery', 'links'],
    ]),
  ),
);

/**
 * SQL predicate that is true when a row's section shows for its persona's kind.
 * Postgres treats a jsonb array as containing a matching scalar, so
 * `@> to_jsonb(section)` is a membership test. A kind missing from the map
 * yields NULL, so the row is excluded.
 */
export function visibleSectionSql(
  sectionColumnSql: string,
  kindColumnSql: string,
  mapParameterSql: string = ':visibleSectionsByKind',
): string {
  return `(CAST(${mapParameterSql} AS jsonb) -> (${kindColumnSql})::text) @> to_jsonb((${sectionColumnSql})::text)`;
}
