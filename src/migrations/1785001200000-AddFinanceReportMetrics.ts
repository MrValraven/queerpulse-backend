import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds numeric per-quarter metric columns to `governance_finance_report`:
 * `income_total`, `expense_total`, `surplus`, `mrr` (all `numeric`),
 * `sustainer_count` (`integer`), and `solidarity_rate` (`numeric`). These
 * back the admin governance page's Finances tab, which needs real per-quarter
 * totals + MRR figures rather than only the curated `stats`/`income`/`expense`
 * jsonb breakdowns. Nullable — added after the table's initial creation, like
 * `reserve`/`partners` before them; not yet backfilled for every historical
 * quarter.
 */
export class AddFinanceReportMetrics1785001200000 implements MigrationInterface {
  name = 'AddFinanceReportMetrics1785001200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "income_total" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "expense_total" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "surplus" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "mrr" numeric`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "sustainer_count" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "solidarity_rate" numeric`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "solidarity_rate"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "sustainer_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "mrr"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "surplus"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "expense_total"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "income_total"`,
    );
  }
}
