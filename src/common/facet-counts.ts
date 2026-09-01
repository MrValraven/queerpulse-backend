import { type ObjectLiteral, type SelectQueryBuilder } from 'typeorm';

/**
 * One aggregate row of `COUNT(*) FILTER (WHERE <option matches>)`, one column
 * per option, over a base query that already carries every filter EXCEPT this
 * group's own predicate. That is what makes a facet count answerable: "how
 * many would I get if I picked this one, given everything else I have already
 * narrowed by".
 *
 * `qb` is mutated (its SELECT list is replaced), so hand it a FRESH builder —
 * never the one the caller is also paginating.
 *
 * Aliases are positional (`f0`, `f1`, …) rather than the option ids themselves:
 * ids like `musicIndustryAR` are camelCase and would come back from Postgres
 * folded to lowercase, and ids are member-facing vocabulary that may gain
 * characters an unquoted SQL alias cannot hold.
 *
 * `COUNT(*)` is only correct while the base query's joins are many-to-one — a
 * join that fans one row out into several would count it once per fanned row.
 * Both callers satisfy that (the member directory's `u` join, and the
 * communities browse's membership join, which is unique per
 * community/viewer pair); `NOT EXISTS` visibility gates are predicates, not
 * joins, and are always safe.
 *
 * Shared by `countDirectoryFacets` (member directory) and
 * `countCommunityTagFacets` (communities browse) so the two cannot drift into
 * counting differently.
 */
export async function countByFilterClauses<E extends ObjectLiteral>(
  qb: SelectQueryBuilder<E>,
  options: readonly string[],
  clause: (param: string) => string,
  parameterFor: (option: string) => unknown,
): Promise<Record<string, number>> {
  if (!options.length) return {};
  qb.select([]);
  options.forEach((option, index) => {
    const param = `facetOption${index}`;
    qb.addSelect(`COUNT(*) FILTER (WHERE ${clause(param)})`, `f${index}`);
    qb.setParameter(param, parameterFor(option));
  });
  const row = await qb.getRawOne<Record<string, string | number | null>>();
  const counts: Record<string, number> = {};
  options.forEach((option, index) => {
    // Postgres returns bigint as a string through node-postgres; a group whose
    // base query matched nothing returns no row at all rather than zeros.
    counts[option] = Number(row?.[`f${index}`] ?? 0);
  });
  return counts;
}
