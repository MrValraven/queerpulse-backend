// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Widens `volunteer_opportunities_cause_enum` from five causes to thirteen.
 *
 * THE PROBLEM. The volunteering board offered exactly five causes (Rights,
 * Health, Youth, Housing, Arts), so anything that was not one of those got
 * filed under whichever was least wrong. A trans healthcare navigator, an
 * elders' befriending round, a Portuguese class for newly arrived asylum
 * seekers and a fundraising shift all collapsed into "Health" or "Rights",
 * which made the cause chips near-useless as a filter: the two biggest
 * categories were the two vaguest ones.
 *
 * THE EIGHT NEW LABELS were chosen to be broad enough that a poster finds
 * theirs in a second, and narrow enough to be worth filtering by:
 * `trans_care`, `elders`, `mental_health`, `migration`, `education`, `sport`,
 * `community_events`, `fundraising`.
 *
 * APPENDED, not inserted. The enum's sort order is never read (nothing does
 * `ORDER BY cause`; the frontend renders causes in its own curated order from
 * `causes.data.ts`), so plain `ADD VALUE` at the tail is correct and avoids
 * eight `BEFORE`/`AFTER` clauses that would imply a meaning the order does not
 * carry.
 *
 * NON-TRANSACTIONAL, like every other `ADD VALUE` migration here (see
 * `AddCommunityCoOwnerRole1793920000000`): `ALTER TYPE ... ADD VALUE` must be
 * COMMITTED before any statement may use the new label, so this opts out of
 * the wrapping transaction (`transaction = false`, honoured because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * `IF NOT EXISTS` keeps it re-run-safe.
 *
 * SPLIT FROM THE COLUMN CHANGE ON PURPOSE.
 * `VolunteerOpportunityMultipleCauses1817060000000` turns the single `cause`
 * column into a `causes` array and backfills it. That migration wants a
 * transaction (it drops a column after copying out of it); this one cannot
 * have one. Keeping them apart is what lets each have the mode it needs, and
 * it means the widened enum is committed and available before anything writes
 * a row using one of the new labels.
 */
export class AddVolunteerOpportunityCauseValues1817050000000 implements MigrationInterface {
  name = 'AddVolunteerOpportunityCauseValues1817050000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const value of [
      'trans_care',
      'elders',
      'mental_health',
      'migration',
      'education',
      'sport',
      'community_events',
      'fundraising',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "volunteer_opportunities_cause_enum" ADD VALUE IF NOT EXISTS '${value}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Reverting needs the
    // rename-and-recreate dance AND a decision about what an opportunity filed
    // under, say, `elders` becomes when the label goes away: a real data
    // decision this migration must not silently guess at.
    // Failing loudly beats reporting a successful revert that undid nothing: a
    // silent no-op removes the ledger row, so the next `migration:run` retries
    // `ADD VALUE` against labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value, and down() would ' +
        'have to decide what opportunities filed under the eight new causes ' +
        'become. Write a follow-up migration by hand if this needs reverting.',
    );
  }
}
