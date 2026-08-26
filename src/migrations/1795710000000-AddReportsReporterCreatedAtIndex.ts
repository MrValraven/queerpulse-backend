// DO NOT RUN. Authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs the rolling report-flood caps (TS-05,
 * `ReportsService.assertReportingWindowIsClear`). Those two counts run on EVERY
 * report submission, before the insert, so they have to be index-served rather
 * than a scan.
 *
 * The queries are:
 *
 *   1. `reporter_id = $1 AND created_at >= $2`  (rolling 24-hour cap)
 *   2. `reporter_id = $1 AND subject_type = $2 AND subject_id = $3
 *       AND created_at >= $4`                   (rolling 7-day per-subject cap)
 *
 * `reports` already indexes `reporter_id` alone (`IDX_reports_reporter_id`,
 * from `AddReportsModeration`) and `(subject_type, created_at DESC)`
 * (`IDX_reports_subject_type_created_at`). Neither serves these: the first
 * makes the planner fetch every row a prolific reporter has ever filed and
 * filter `created_at` off the heap, and the second is keyed on the subject
 * type, not the reporter. The existing partial unique index
 * `UQ_reports_open_reporter_subject` is scoped `WHERE status = 'open'`, and
 * both caps deliberately count rows at any status, so it cannot serve them
 * either.
 *
 * This composite b-tree on `(reporter_id, created_at DESC)` turns query 1 into
 * a bounded index range scan. It serves query 2 as well, and that is why this
 * migration adds ONE index rather than two: the daily cap enforced immediately
 * before query 2 runs bounds a reporter's rows in the 7-day window at roughly
 * seven times the daily ceiling, so the per-subject count filters its subject
 * columns over a couple of hundred tuples at the very worst. A second,
 * subject-bearing index would buy nothing measurable and would cost a write on
 * every insert into a table that only ever grows.
 *
 * `IDX_reports_reporter_id` becomes a redundant prefix of this index. It is
 * left in place deliberately: dropping a shipped index is a separate decision
 * with its own blast radius, and it is not what this change is for.
 *
 * The `reports` table carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY`, which cannot run inside a transaction block. The
 * migration therefore opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`), exactly as
 * `1785903000000-AddReportsSubjectTypeCreatedAtIndex` does on this same table.
 * Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * UNAPPLIED. The maintainer runs `pnpm run migration:run`.
 */
export class AddReportsReporterCreatedAtIndex1795710000000 implements MigrationInterface {
  name = 'AddReportsReporterCreatedAtIndex1795710000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_reports_reporter_created_at" ` +
        `ON "reports" ("reporter_id", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_reports_reporter_created_at"`,
    );
  }
}
