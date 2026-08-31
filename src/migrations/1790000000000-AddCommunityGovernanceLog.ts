import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `community_governance_log` — an immutable audit trail of governance
 * actions against a community's roster/lifecycle (role changes, removals,
 * ownership transfers, archive/freeze/unfreeze, and the automatic owner→mod
 * promotion `CommunityOwnerOrphanService.handleOwnerErasure` performs when an
 * owner's account is erased). Written exclusively through
 * `CommunityGovernanceLogService.log()` (see
 * `src/communities/community-governance-log.service.ts`); wiring calls into
 * `CommunitiesService` for the manual actions is a follow-up task — this
 * migration + its service only make the sink exist.
 *
 * `community_id` is `ON DELETE CASCADE` (no log without the community it
 * describes). `actor_user_id` / `target_user_id` are nullable + `ON DELETE
 * SET NULL`, matching the erasure-survival pattern used throughout this
 * feature (`community_post_edit.editor_id`, `reports.reporter_id`,
 * `mod_audit_logs.actor_id`): an audit trail must outlive the people it
 * names, whether they are the moderator who acted or the member acted upon.
 */
export class AddCommunityGovernanceLog1790000000000 implements MigrationInterface {
  name = 'AddCommunityGovernanceLog1790000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_governance_log_action_enum" AS ENUM(
        'role_changed',
        'member_removed',
        'ownership_transferred',
        'archived',
        'frozen',
        'unfrozen',
        'owner_auto_promoted'
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "community_governance_log" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "community_id" uuid NOT NULL,
        "actor_user_id" uuid,
        "action" "community_governance_log_action_enum" NOT NULL,
        "target_user_id" uuid,
        "metadata" jsonb,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_governance_log" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_community_governance_log_community_id" ON "community_governance_log" ("community_id")`,
    );

    await queryRunner.query(`
      ALTER TABLE "community_governance_log" ADD CONSTRAINT "FK_community_governance_log_community_id"
        FOREIGN KEY ("community_id") REFERENCES "communities"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_governance_log" ADD CONSTRAINT "FK_community_governance_log_actor_user_id"
        FOREIGN KEY ("actor_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_governance_log" ADD CONSTRAINT "FK_community_governance_log_target_user_id"
        FOREIGN KEY ("target_user_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_governance_log" DROP CONSTRAINT "FK_community_governance_log_target_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_governance_log" DROP CONSTRAINT "FK_community_governance_log_actor_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_governance_log" DROP CONSTRAINT "FK_community_governance_log_community_id"`,
    );
    await queryRunner.query(`DROP TABLE "community_governance_log"`);
    await queryRunner.query(`DROP TYPE "community_governance_log_action_enum"`);
  }
}
