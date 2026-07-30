import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Integrity fix: `reports` had no unique guard behind
 * `ReportsService.create`'s "one open report per (reporter, subject)"
 * de-duplication — it was a plain check-then-insert (`findOne` then `save`),
 * so two concurrent identical filings could both miss the read and both
 * insert, piling duplicate open reports on the moderation queue.
 *
 * Adds a PARTIAL unique index on `(reporter_id, subject_type, subject_id)`
 * scoped to `WHERE status = 'open'`: at most one open report per reporter per
 * subject, while still allowing a member to re-file once a prior report is
 * resolved/escalated (a recurrence after a resolution is worth surfacing
 * again). `ReportsService.create` now catches the 23505 this raises and
 * returns the report that won the race, so the endpoint stays idempotent.
 *
 * The matching `@Index('UQ_reports_open_reporter_subject', …, { unique: true,
 * where: "status = 'open'" })` decorator is on the `Report` entity
 * (class-level) so entity metadata and schema stay in sync for any future
 * `migration:generate` diff.
 *
 * `CONCURRENTLY` because `reports` already carries production traffic — a plain
 * `CREATE UNIQUE INDEX` would hold a lock that blocks writes for the build's
 * duration. Mirrors `1785002600000-AddSavedItemSubjectIndex.ts`, the repo's
 * convention for adding an index to an already-populated table.
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block; this
 * migration runs on its own (`transaction = false` + `migrationsTransactionMode:
 * 'each'` in data-source.ts):
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * NOTE: index creation validates against existing data, so it fails loudly if
 * the table already holds duplicate OPEN reports for a (reporter, subject) —
 * de-duplicate those rows first if so.
 */
export class AddReportsOpenDedupeIndex1785003000000
  implements MigrationInterface
{
  name = 'AddReportsOpenDedupeIndex1785003000000';

  // Runs outside a transaction for `CREATE UNIQUE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). See 1785002600000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX CONCURRENTLY "UQ_reports_open_reporter_subject" ` +
        `ON "reports" ("reporter_id", "subject_type", "subject_id") ` +
        `WHERE "status" = 'open'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "UQ_reports_open_reporter_subject"`,
    );
  }
}
