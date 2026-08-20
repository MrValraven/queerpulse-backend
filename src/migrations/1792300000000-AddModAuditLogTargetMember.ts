import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `mod_audit_logs.target_user_id` + `target_name` (P0-16 / ADM-5).
 *
 * `role_changed` / `staff_role_granted` / `staff_role_revoked` rows
 * (`AdminMembersService.updateRole` / `grantStaffRole` / `revokeStaffRole`)
 * were written with `report_id = NULL` and no other column identifying which
 * member the action was taken against. `ModAuditService.subjectFor()` only
 * knows how to describe a row via its linked report, so every one of these
 * rows rendered the literal fallback string "Platform action" — an audit
 * trail that can't answer "who was promoted, by whom".
 *
 * Two columns, mirroring the erasure-safe shape already used elsewhere on
 * this table (`actor_id`, and `reports.resolution_actor_id`):
 *  - `target_user_id`: nullable + `ON DELETE SET NULL`, so the row survives
 *    the target member's erasure instead of losing its link entirely.
 *  - `target_name`: a denormalized snapshot of the target's display name at
 *    write time (nullable, no FK). Immutable once written, like `note` —
 *    this is what actually renders in the audit feed's "subject" column, so
 *    it keeps working even after `target_user_id` is NULLed by erasure or the
 *    member later changes their name.
 *
 * Both nullable with no backfill: every existing row keeps `target_user_id`/
 * `target_name` NULL (per the task, historical rows are not backfilled), and
 * `subjectFor()` still falls back to its prior report-based logic — only
 * "Platform action" as the final fallback is what changes going forward, once
 * the three write sites above start populating these columns.
 */
export class AddModAuditLogTargetMember1792300000000 implements MigrationInterface {
  name = 'AddModAuditLogTargetMember1792300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ADD "target_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" ADD "target_name" character varying`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_mod_audit_logs_target_user_id" ON "mod_audit_logs" ("target_user_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "mod_audit_logs" ADD CONSTRAINT "FK_mod_audit_logs_target_user_id"
        FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP CONSTRAINT "FK_mod_audit_logs_target_user_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_mod_audit_logs_target_user_id"`);
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP COLUMN "target_name"`,
    );
    await queryRunner.query(
      `ALTER TABLE "mod_audit_logs" DROP COLUMN "target_user_id"`,
    );
  }
}
