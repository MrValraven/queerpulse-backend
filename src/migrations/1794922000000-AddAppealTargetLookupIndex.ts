import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * TS-11, step 5. The index behind "which decision is this member appealing?"
 * for a decision that was never attached to a report.
 *
 * `ModerationService.resolveAppealTarget` used to reach the appealed action
 * exactly one way: through a `member`-subject report about the appellant, then
 * through the `mod_audit_logs` rows carrying that report's id. Every sanction
 * recorded WITHOUT a report was therefore unappealable in practice, however
 * loudly the Code of Conduct said otherwise. That set is not small: a community
 * ban (which writes `community_ban_applied` with a NULL `report_id` and the
 * barred member in `target_user_id`) and a direct admin restriction from the
 * member drawer are both in it.
 *
 * The resolver now also matches on `target_user_id`, newest first. This is the
 * covering index for that lookup: `(target_user_id, created_at DESC)`, partial
 * on `target_user_id IS NOT NULL` so it stays the size of the target-bearing
 * rows rather than the whole audit table (the overwhelming majority of rows
 * carry a `report_id` and a NULL target). `action` is not in the key: the set
 * of rows for one member is small enough that filtering it after the index
 * scan is cheaper than a third key column, and keeping `action` out means the
 * index does not have to be rebuilt every time the appealable-action list
 * changes.
 *
 * `IDX_mod_audit_logs_target_user_id` (from
 * `1792300000000-AddModAuditLogTargetMember`) stays: it serves the
 * equality-only lookups on the admin member timeline. This one adds the
 * ordering the appeal resolver needs.
 *
 * Plain `CREATE INDEX`, so this file stays transactional like every other
 * migration in this batch. `mod_audit_logs` is append-only and small at this
 * project's scale; a `CONCURRENTLY` build would need its own non-transactional
 * runbook for no benefit here.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddAppealTargetLookupIndex1794922000000 implements MigrationInterface {
  name = 'AddAppealTargetLookupIndex1794922000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_mod_audit_logs_target_created_at" ON "mod_audit_logs" ("target_user_id", "created_at" DESC) WHERE "target_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_mod_audit_logs_target_created_at"`,
    );
  }
}
