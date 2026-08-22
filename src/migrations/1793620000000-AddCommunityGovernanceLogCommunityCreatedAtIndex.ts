import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the new read path over `community_governance_log`
 * (`GET /admin/communities/:slug/governance-log`, BE-COM-15).
 *
 * The table was write-only until now, so its only index was the plain
 * `IDX_community_governance_log_community_id`
 * (`1790000000000-AddCommunityGovernanceLog.ts`) that the FK needed. The
 * reader filters on `community_id` and sorts `created_at DESC, id DESC` with
 * an offset `LIMIT`; a single-column index on `community_id` alone can serve
 * the filter but not the sort, so Postgres would still have to materialise
 * and sort every entry for the community before returning the first page.
 * This composite index makes the ordered page a bounded index scan.
 *
 * `id DESC` is the tiebreak inside the index because `created_at` is not
 * unique — entries written inside one transaction share a timestamp to the
 * microsecond, and an offset page over a non-deterministic order can repeat
 * or skip a row at the page boundary.
 *
 * The pre-existing single-column `IDX_community_governance_log_community_id`
 * is deliberately left in place: it is the index the three `ON DELETE`
 * foreign keys use for their referential-integrity checks, and this composite
 * one is a superset only for lookups that also care about the ordering.
 *
 * Built `CREATE INDEX CONCURRENTLY` (never a blocking plain `CREATE INDEX`)
 * against a table that already carries production writes, which is why this
 * migration sets `transaction = false` and lives in its own file with no
 * other DDL in it.
 */
export class AddCommunityGovernanceLogCommunityCreatedAtIndex1793620000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceLogCommunityCreatedAtIndex1793620000000';

  // CONCURRENTLY cannot run inside a transaction block ("`CREATE INDEX`",
  // PostgreSQL manual) — `migrationsTransactionMode: 'each'` (data-source.ts)
  // is what lets this migration opt out per-migration via `transaction = false`
  // instead of being force-wrapped into one shared batch transaction.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_governance_log_community_id_created_at" ` +
        `ON "community_governance_log" ("community_id", "created_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_governance_log_community_id_created_at"`,
    );
  }
}
