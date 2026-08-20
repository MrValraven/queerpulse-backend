import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a real assignee to `reports` (COM-5): `assigned_moderator_id` +
 * `assigned_at`. Before this, the moderation queue's "Assigned to me" filter
 * (`filter=mine`) was a documented no-op — there was no column to filter by,
 * so it silently returned the same unfiltered results as "All severities"
 * (see the removed comment in `ModerationService.list`).
 *
 * Nullable, no default: NULL = unassigned (every existing report lands
 * unassigned). `assigned_moderator_id` mirrors the erasure-safe pattern
 * `AddDeletionErasureSupport1782800700000` established for
 * `reports.reporter_id` / `mod_audit_logs.actor_id` — nullable + `ON DELETE
 * SET NULL`, so a report an erased moderator had claimed reverts to
 * unassigned rather than either blocking the erasure sweep or leaving a
 * dangling uuid. `assigned_at` is the watermark (mirrors
 * `forum_thread.pinned_at`, `AddForumThreadPinnedAt`) — set together with the
 * assignee, cleared together on unassign.
 *
 * `IDX_reports_assigned_moderator_id` backs the `filter=mine` query
 * (`WHERE assigned_moderator_id = :actorId`) — every other queue filter
 * (`severity`, `subjectType`, `status`) already has one.
 */
export class AddReportAssignee1792700100000 implements MigrationInterface {
  name = 'AddReportAssignee1792700100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "assigned_moderator_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "assigned_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_assigned_moderator_id"
        FOREIGN KEY ("assigned_moderator_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_assigned_moderator_id" ON "reports" ("assigned_moderator_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_reports_assigned_moderator_id"`);
    await queryRunner.query(
      `ALTER TABLE "reports" DROP CONSTRAINT "FK_reports_assigned_moderator_id"`,
    );
    await queryRunner.query(`ALTER TABLE "reports" DROP COLUMN "assigned_at"`);
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "assigned_moderator_id"`,
    );
  }
}
