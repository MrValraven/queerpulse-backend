import { type DataSource, type SelectQueryBuilder } from 'typeorm';
import {
  OpportunityCause,
  OpportunityCommitLevel,
  VolunteerOpportunity,
} from './entities/volunteer-opportunity.entity';

/** One `GROUP BY` row: the grouped enum value and its count. Postgres returns
 *  `COUNT(*)` as a bigint, which node-postgres hands back as a string. */
interface FacetCountRow {
  value: string;
  opportunity_count: string | number;
}

/**
 * Every value of `options` keyed to 0, then overwritten by the grouped rows.
 * A value nobody is filed under is a real answer (the board greys its chip
 * out), so the map always carries the full enum. A row whose value is not in
 * the enum (a label added to the Postgres type ahead of the code) is dropped
 * so the wire shape stays exactly the enum the frontend builds against.
 */
function fillFacetCounts<Option extends string>(
  options: readonly Option[],
  rows: FacetCountRow[],
): Record<Option, number> {
  const counts = Object.fromEntries(
    options.map((option) => [option, 0]),
  ) as Record<Option, number>;
  for (const row of rows) {
    if (row.value in counts) {
      counts[row.value as Option] = Number(row.opportunity_count);
    }
  }
  return counts;
}

/**
 * How many board opportunities each time commitment would yield, over the
 * base query with the `commit` filter lifted (`VolunteeringService
 * .boardBaseQuery`'s `lift: 'commit'`). So a number answers "how many would I
 * get if I picked this commitment, given the cause already chosen". Its own
 * predicate left in would make the unselected commitment count 0 the moment
 * one was picked.
 *
 * `commit` is a single scalar column, so a plain `GROUP BY` counts each
 * opportunity exactly once.
 *
 * Mutates the builder it is handed (its SELECT list is replaced), so pass a
 * fresh one.
 */
export async function countOpportunityCommitFacets(
  base: SelectQueryBuilder<VolunteerOpportunity>,
): Promise<Record<OpportunityCommitLevel, number>> {
  const rows = await base
    .select('o.commit', 'value')
    .addSelect('COUNT(*)', 'opportunity_count')
    .groupBy('o.commit')
    .getRawMany<FacetCountRow>();
  return fillFacetCounts(Object.values(OpportunityCommitLevel), rows);
}

/**
 * How many board opportunities each cause would yield, over the base query
 * with the `cause` filter lifted (`lift: 'cause'`) and the `commit` filter
 * still applied. An opportunity lists one to three causes, so it counts once
 * under EACH of them: the same reading the `&&` filter gives, where a chip
 * finds a cause in any position.
 *
 * `unnest(o.causes)` fans each row out into one row per cause. Postgres
 * rejects a set-returning function in `GROUP BY`, so the fan-out runs as a
 * subquery and the outer query groups over its column. `dedupeCauses` keeps a
 * cause from appearing twice in one row, so the fan-out never double counts.
 * The subquery's bound parameters (the commit filter and both visibility
 * gates) are carried over onto the outer builder.
 *
 * Mutates the builder it is handed (its SELECT list is replaced), so pass a
 * fresh one.
 */
export async function countOpportunityCauseFacets(
  base: SelectQueryBuilder<VolunteerOpportunity>,
  dataSource: DataSource,
): Promise<Record<OpportunityCause, number>> {
  const causesPerOpportunity = base.select('unnest(o.causes)', 'cause');
  const rows = await dataSource
    .createQueryBuilder()
    .select('"opportunity_cause"."cause"', 'value')
    .addSelect('COUNT(*)', 'opportunity_count')
    .from(`(${causesPerOpportunity.getQuery()})`, 'opportunity_cause')
    .setParameters(causesPerOpportunity.getParameters())
    .groupBy('"opportunity_cause"."cause"')
    .getRawMany<FacetCountRow>();
  return fillFacetCounts(Object.values(OpportunityCause), rows);
}
