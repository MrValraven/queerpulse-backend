import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the admin write path's audit trail for the five `governance_overview`
 * sections (Health, Moderation steps, Council, Principles, Decisions) — the
 * sibling of `AddGovernanceFinanceProvenance`, at section granularity instead
 * of per-scalar, since overview sections are edited as whole ordered arrays.
 *
 * `governance_overview_changes` is the only new object: one immutable row per
 * changed section, holding the full before/after array. There is no
 * `updated_by`/`updated_at` column added to `governance_overview` itself —
 * the admin "last edited by X on Y" badge is computed per section from the
 * most recent row in this table (see `GovernanceOverviewService.getAdminOverview`),
 * so a Council edit never makes the Health badge look touched.
 */
export class AddGovernanceOverviewAdminAudit1790600000000
  implements MigrationInterface
{
  name = 'AddGovernanceOverviewAdminAudit1790600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "governance_overview_section_enum" AS ENUM('health', 'moderationSteps', 'council', 'principles', 'decisions')`,
    );

    await queryRunner.query(`
      CREATE TABLE "governance_overview_changes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "section" "governance_overview_section_enum" NOT NULL,
        "actor_id" uuid,
        "before" jsonb NOT NULL,
        "after" jsonb NOT NULL,
        "note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_overview_changes" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_overview_changes_section" ON "governance_overview_changes" ("section")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_overview_changes_actor_id" ON "governance_overview_changes" ("actor_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_overview_changes_created_at" ON "governance_overview_changes" ("created_at")`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_overview_changes" ADD CONSTRAINT "FK_governance_overview_changes_actor_id" FOREIGN KEY ("actor_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_overview_changes" DROP CONSTRAINT "FK_governance_overview_changes_actor_id"`,
    );
    await queryRunner.query(`DROP TABLE "governance_overview_changes"`);
    await queryRunner.query(`DROP TYPE "governance_overview_section_enum"`);
  }
}
