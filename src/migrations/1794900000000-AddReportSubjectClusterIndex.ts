import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A covering index for the moderation queue's subject clusters (TS-06).
 *
 * `ModerationService.clustersFor` groups every UNRESOLVED report by
 * `(subject_type, subject_id)` to answer the question the flat queue could
 * not: how many open reports there really are about this subject, and how many
 * DIFFERENT people are behind them. `applySurgeFilter` runs the same grouping
 * as a semi-join. Both statements read only `reporter_id`, `severity`,
 * `sla_due_at`, `created_at` and `id` on top of the grouping keys, so those
 * ride along in `INCLUDE` and the aggregate can be answered index-only.
 *
 * Partial on `status IN ('open', 'escalated')`. A pile is a live pile: once a
 * report is resolved it stops counting toward the cluster, and resolved rows
 * are the ones that accumulate forever. Keeping them out holds the index at
 * roughly the size of the open queue rather than the size of the archive.
 *
 * The existing `IDX_reports_subject` is on `subject_type` alone, which cannot
 * serve a group-by on the pair, and `UQ_reports_open_reporter_subject` leads
 * with `reporter_id`, which is the wrong prefix for this question.
 *
 * `CREATE INDEX` (not CONCURRENTLY) so this file stays transactional, matching
 * every other index migration in this directory. Building it takes an
 * exclusive lock on `reports` for the duration; the table is small, and mixing
 * CONCURRENTLY with transactional DDL needs a two-phase run this single
 * statement does not justify.
 */
export class AddReportSubjectClusterIndex1794900000000 implements MigrationInterface {
  name = 'AddReportSubjectClusterIndex1794900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_open_subject_cluster"
         ON "reports" ("subject_type", "subject_id")
         INCLUDE ("id", "reporter_id", "severity", "sla_due_at", "created_at")
         WHERE "status" IN ('open', 'escalated')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX IF EXISTS "IDX_reports_open_subject_cluster"`,
    );
  }
}
