// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-28. The index behind "which community was this member removed from?".
 *
 * A removal that lets the member come back now writes a
 * `community_member_removed` row into `mod_audit_logs`, which is what makes it
 * appealable (`POST /appeals` resolves its target out of that table). That row
 * carries no community of its own, and unlike a bar the removal leaves no
 * `community_bans` row to reach the room through, so
 * `ModerationService.communitySlugForCommunityRemoval` reads the community's
 * own governance log: newest `member_removed` entry for this member.
 *
 * This is the covering index for that lookup: `(target_user_id, created_at
 * DESC)`, partial on `target_user_id IS NOT NULL` so it stays the size of the
 * member-directed rows rather than the whole log (lifecycle entries such as an
 * archive or a freeze name no member). `action` is deliberately out of the key,
 * for the same reason `IDX_mod_audit_logs_target_created_at` keeps it out: one
 * member's entries are few enough that filtering them after the index scan is
 * cheaper than a third key column.
 *
 * `IDX_community_governance_log_community_id_created_at` stays: it serves the
 * per-community log page. This one serves the per-member lookup, which had no
 * index at all.
 *
 * Plain `CREATE INDEX`, so this file stays transactional. `CONCURRENTLY` would
 * need its own non-transactional runbook for a table this size.
 */
export class AddGovernanceLogTargetLookupIndex1795790000000 implements MigrationInterface {
  name = 'AddGovernanceLogTargetLookupIndex1795790000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX "IDX_community_governance_log_target_created_at" ON "community_governance_log" ("target_user_id", "created_at" DESC) WHERE "target_user_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_community_governance_log_target_created_at"`,
    );
  }
}
