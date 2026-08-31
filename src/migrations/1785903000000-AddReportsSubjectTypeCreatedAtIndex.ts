import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Backs `AdminCommunitiesService.loadReportScope` (AUDIT item #18): that query
 * filters `subject_type IN (...)` and orders `created_at DESC` with a bounded
 * `LIMIT` (the new `MAX_SCANNED_REPORTS` cap). The `reports` table already
 * indexes `subject_type`, `severity`, and `status` individually
 * (`IDX_reports_subject` / `IDX_reports_severity` / `IDX_reports_status`) but
 * NOT `created_at`, so the planner could satisfy the `subject_type` filter by
 * index yet still had to sort every matching row by `created_at` before
 * applying the limit. This composite b-tree on `(subject_type, created_at DESC)`
 * lets it serve the whole `subject_type IN (...) ORDER BY created_at DESC LIMIT`
 * as an ordered index scan that stops after the cap.
 *
 * The `reports` table carries production traffic, so the index is built
 * `CREATE INDEX CONCURRENTLY` — which cannot run inside a transaction block, so
 * the migration opts out (`transaction = false`, honored because
 * `data-source.ts` sets `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class AddReportsSubjectTypeCreatedAtIndex1785903000000 implements MigrationInterface {
  name = 'AddReportsSubjectTypeCreatedAtIndex1785903000000';

  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_reports_subject_type_created_at" ` +
        `ON "reports" ("subject_type", "created_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_reports_subject_type_created_at"`,
    );
  }
}
