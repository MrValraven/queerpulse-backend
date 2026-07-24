import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `reserve` + `partners` (`jsonb`, nullable) to
 * `governance_finance_report`. These are the operational-reserve progress
 * figures and disclosed restricted-grant partners that render inside
 * `FinancesSection` — they shift quarter to quarter, so they live on the
 * quarterly report rather than the evergreen `governance_overview`. Nullable
 * because they were added after the table; the seeded Q2 2026 row is backfilled
 * by `src/governance/governance-finance.seed.ts`.
 */
export class AddGovernanceFinanceReserveAndPartners1785000230000
  implements MigrationInterface
{
  name = 'AddGovernanceFinanceReserveAndPartners1785000230000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "reserve" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" ADD "partners" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "partners"`,
    );
    await queryRunner.query(
      `ALTER TABLE "governance_finance_report" DROP COLUMN "reserve"`,
    );
  }
}
