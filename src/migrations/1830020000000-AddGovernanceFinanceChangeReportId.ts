// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * RES-F9. A `report_id` on `governance_finance_changes`, so every audit row
 * names the quarterly report it changed.
 *
 * WHY. The trail recorded who changed which field, from what, to what, but
 * not on which report. Once a second quarter was open, "mrr went from 1840 to
 * 2100" could belong to either one, and only the timestamps hinted which.
 *
 * NO BACKFILL. Older rows never stored the report, and the field and the
 * timestamps cannot recover it reliably (a quarter can be edited after the
 * next one opens), so they keep `report_id` null. The admin trail reads null
 * as "report not recorded".
 *
 * `ON DELETE SET NULL`, matching `actor_id`: an audit row outlives the report
 * it describes. Indexed, so a per-report history read stays cheap.
 *
 * Purely additive: one nullable column, its foreign key and its index.
 */
export class AddGovernanceFinanceChangeReportId1830020000000 implements MigrationInterface {
  name = 'AddGovernanceFinanceChangeReportId1830020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" ADD "report_id" uuid`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_governance_finance_changes_report_id" ON "governance_finance_changes" ("report_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" ADD CONSTRAINT "FK_governance_finance_changes_report_id" FOREIGN KEY ("report_id") REFERENCES "governance_finance_report"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" DROP CONSTRAINT "FK_governance_finance_changes_report_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_governance_finance_changes_report_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_changes" DROP COLUMN "report_id"`,
    );
  }
}
