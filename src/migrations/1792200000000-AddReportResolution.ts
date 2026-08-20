import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Denormalizes a resolved report's outcome onto `reports` (COM-7):
 * `resolved_at`, `resolution_actor_id`, `resolution_action`,
 * `resolution_duration`, `resolution_note`, `resolution_notified`.
 *
 * Before this, `moderation-response.ts` never wrote a `resolution` block —
 * the frontend's `ModReportDTO.resolution` contract (outcome badge, deciding
 * moderator, close time, member-facing note, who was notified) existed on
 * paper only, and the "resolved" tab's `closed` label fell back to
 * `report.createdAt` (filing time, not resolution time) because no
 * resolution timestamp existed anywhere.
 *
 * Denormalized onto the row rather than resolved via a join, mirroring how
 * this same table already denormalizes derived state at write time
 * (`severity`/`sla_due_at` — see `report-severity.ts`): a resolved report's
 * outcome is decided once, at `actOnReport`/`bulkActOnReports` time, by the
 * exact moderator action + note already in hand — there is no second source
 * of truth to keep in sync with a join. `resolution_actor_id` follows the
 * same erasure-safe shape as `reports.reporter_id` / `mod_audit_logs.actor_id`
 * (`AddDeletionErasureSupport1782800700000`): nullable + `ON DELETE SET
 * NULL`, so the resolved report survives the deciding moderator erasing their
 * account (the DTO layer resolves a NULL actor to "Deleted member", matching
 * `ModAuditService.resolveActorName`).
 *
 * All columns nullable with no default: NULL `resolved_at` means "never
 * resolved" (open/escalated reports, and every existing row before this
 * migration runs) — `moderation-response.ts` only builds the `resolution`
 * DTO block when `resolvedAt` is set.
 */
export class AddReportResolution1792200000000 implements MigrationInterface {
  name = 'AddReportResolution1792200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "resolved_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "resolution_actor_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "resolution_action" character varying`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "resolution_duration" character varying`,
    );
    await queryRunner.query(`ALTER TABLE "reports" ADD "resolution_note" text`);
    // Small, fixed-vocabulary set ("member" | "reporter" | "affected") — a
    // native array column over a jsonb blob, matching this table's existing
    // `evidence jsonb[]`-adjacent precedent of storing small denormalized
    // lists inline rather than a join table for a per-report cardinality that
    // never exceeds a couple of entries.
    await queryRunner.query(
      `ALTER TABLE "reports" ADD "resolution_notified" character varying array`,
    );
    await queryRunner.query(`
      ALTER TABLE "reports" ADD CONSTRAINT "FK_reports_resolution_actor_id"
        FOREIGN KEY ("resolution_actor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "reports" DROP CONSTRAINT "FK_reports_resolution_actor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "resolution_notified"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "resolution_note"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "resolution_duration"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "resolution_action"`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" DROP COLUMN "resolution_actor_id"`,
    );
    await queryRunner.query(`ALTER TABLE "reports" DROP COLUMN "resolved_at"`);
  }
}
