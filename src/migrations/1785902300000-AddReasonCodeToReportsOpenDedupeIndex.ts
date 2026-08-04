import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Correctness fix: the partial unique index behind
 * `ReportsService.create`'s open-report de-duplication keyed only on
 * `(reporter_id, subject_type, subject_id)` — no `reason_code`. So one member
 * filing two DISTINCT reasons against the same subject collapsed to one open
 * report: e.g. a `listing_dispute` then a high-severity abuse report on the
 * same listing returned the dispute and silently dropped the abuse report.
 *
 * Rebuilds `UQ_reports_open_reporter_subject` (same name, so the 23505 catch in
 * `ReportsService.create` — `isUniqueViolation(error,
 * 'UQ_reports_open_reporter_subject')` — keeps matching) to include
 * `reason_code`: at most one OPEN report per `(reporter, subject, reason)`.
 * Same-reason duplicates still collapse (the intended idempotency); two
 * different reasons on one subject now both reach the moderation queue.
 *
 * The predicate is unchanged from the superseded
 * `1785003000000-AddReportsOpenDedupeIndex` — `WHERE "status" = 'open'` — so a
 * member can still re-file once a prior report is resolved/escalated.
 *
 * `CONCURRENTLY` (both DROP and CREATE) because `reports` carries production
 * traffic — a plain build/drop would hold a lock that blocks writes. Neither
 * `CREATE INDEX CONCURRENTLY` nor `DROP INDEX CONCURRENTLY` can run inside a
 * transaction block, so this migration runs on its own (`transaction = false` +
 * `migrationsTransactionMode: 'each'` in data-source.ts), mirroring
 * `1785003000000`:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * NOTE: the rebuilt index validates against existing data, so it fails loudly
 * if the table already holds duplicate OPEN reports for a
 * `(reporter, subject, reason)` — de-duplicate those rows first if so.
 */
export class AddReasonCodeToReportsOpenDedupeIndex1785902300000 implements MigrationInterface {
  name = 'AddReasonCodeToReportsOpenDedupeIndex1785902300000';

  // Runs outside a transaction for `CREATE/DROP INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). See 1785003000000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_reports_open_reporter_subject"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_reports_open_reporter_subject" ` +
        `ON "reports" ("reporter_id", "subject_type", "subject_id", "reason_code") ` +
        `WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_reports_open_reporter_subject"`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_reports_open_reporter_subject" ` +
        `ON "reports" ("reporter_id", "subject_type", "subject_id") ` +
        `WHERE "status" = 'open'`,
    );
  }
}
