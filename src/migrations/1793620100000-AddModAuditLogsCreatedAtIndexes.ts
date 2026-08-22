import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Indexes the two columns the moderation audit reads actually filter and sort
 * on (BE-COM-27).
 *
 * `mod_audit_logs` carried indexes only on its three foreign keys
 * (`report_id`, `actor_id`, `target_user_id` — `1782800020000-AddReportsModeration`
 * and `1792300000000-AddModAuditLogTargetMember`). Every global reader instead
 * orders by `created_at DESC` and filters on `action`:
 *
 *   - `ModAuditService.auditFeed` / `auditFeedCsv` (`GET /mod/audit`,
 *     `/mod/audit.csv`) — `ORDER BY created_at DESC` with an optional
 *     `action = :action` and a `created_at >= :floor` range filter, paginated
 *     or dumped up to 5000 rows.
 *   - `AdminOverviewService` — `action IN (...)` plus `created_at >= window`.
 *   - `ModerationService`'s latest-appealable-action lookup — `action IN (...)`.
 *
 * With no index on either column, each of those is a sequential scan plus a
 * sort over the fastest-growing table in moderation. Two indexes rather than
 * one: the plain `created_at DESC` serves the unfiltered feed and the range
 * window, and the composite `(action, created_at DESC)` serves the filtered
 * feed as a single ordered index scan (a leading `action` equality lets
 * Postgres read the `created_at` order straight out of the index instead of
 * sorting the matched rows).
 *
 * Built `CREATE INDEX CONCURRENTLY` against a table that already carries
 * production writes, which is why this migration sets `transaction = false`
 * and holds nothing but these index statements.
 */
export class AddModAuditLogsCreatedAtIndexes1793620100000 implements MigrationInterface {
  name = 'AddModAuditLogsCreatedAtIndexes1793620100000';

  // CONCURRENTLY cannot run inside a transaction block ("`CREATE INDEX`",
  // PostgreSQL manual) — `migrationsTransactionMode: 'each'` (data-source.ts)
  // is what lets this migration opt out per-migration via `transaction = false`
  // instead of being force-wrapped into one shared batch transaction.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_mod_audit_logs_created_at" ` +
        `ON "mod_audit_logs" ("created_at" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_mod_audit_logs_action_created_at" ` +
        `ON "mod_audit_logs" ("action", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_mod_audit_logs_action_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_mod_audit_logs_created_at"`,
    );
  }
}
