import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `governance_overview`, a **singleton** `jsonb` document holding the
 * non-financial structure of `/about/governance` (health snapshot, moderation
 * steps, advisory council, principles, decision log), backing
 * `GET /governance/overview`. Structure-only + seeded (translated prose stays
 * in the frontend i18n catalogs) — see `src/governance/governance-overview.seed.ts`.
 * One row, keyed on the fixed id `'current'`; no authoring endpoint.
 */
export class AddGovernanceOverview1785000220000 implements MigrationInterface {
  name = 'AddGovernanceOverview1785000220000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "governance_overview" (
        "id" character varying(20) NOT NULL,
        "health" jsonb NOT NULL,
        "moderation_steps" jsonb NOT NULL,
        "council" jsonb NOT NULL,
        "principles" jsonb NOT NULL,
        "decisions" jsonb NOT NULL,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_overview" PRIMARY KEY ("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "governance_overview"`);
  }
}
