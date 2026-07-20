import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `governance` module's schema: `governance_finance_report`, a
 * read-only quarterly financial-transparency snapshot backing
 * `GET /governance/finances` (see `src/governance/`), seeded from the
 * frontend's `queerpulse/src/features/governance/governance.data.ts`
 * (`FIN_STATS`/`INCOME`/`EXPENSE`/`EVENTS`) — see
 * `src/governance/governance-finance.seed.ts`. No authoring endpoint.
 *
 * DO NOT RUN — authored for review only, per the task's instructions.
 */
export class AddGovernanceFinance1782800620000 implements MigrationInterface {
  name = 'AddGovernanceFinance1782800620000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "governance_finance_report" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "quarter" character varying(20) NOT NULL,
        "stats" jsonb NOT NULL,
        "income" jsonb NOT NULL,
        "expense" jsonb NOT NULL,
        "event_notes" jsonb NOT NULL,
        "published_at" TIMESTAMP WITH TIME ZONE NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_governance_finance_report" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_governance_finance_report_quarter" ON "governance_finance_report" ("quarter")`,
    );
    // Supports the hot path: "most recently published report" (the finances
    // section's default view with no `quarter` filter).
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_finance_report_published_at" ON "governance_finance_report" ("published_at" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_governance_finance_report_published_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "UQ_governance_finance_report_quarter"`,
    );
    await queryRunner.query(`DROP TABLE "governance_finance_report"`);
  }
}
