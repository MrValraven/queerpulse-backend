import { MigrationInterface, QueryRunner } from 'typeorm';
import { governanceOverviewSeed } from '../governance/governance-overview.seed';
import {
  financeHistorySeed,
  governanceFinanceReportSeed,
} from '../governance/governance-finance.seed';

/**
 * Seeds the `/about/governance` page's backing content in every environment.
 *
 * The governance tables are created empty by their schema migrations
 * (`AddGovernanceOverview`, `AddGovernanceFinance`,
 * `AddGovernanceFinanceReserveAndPartners`), and the only code that populated
 * them was `seedGovernanceOverview()` / `seedGovernanceFinance()` in
 * `src/database/seed.ts` — which **refuses to run when
 * `NODE_ENV=production`** (it also inserts fixture members). So in production
 * the tables exist but are empty, and both `GET /governance/overview` and
 * `GET /governance/finances` 404 (their services throw `NotFoundException`
 * when the row is missing).
 *
 * This is fixed "structure in the DB, words in i18n" content with no authoring
 * endpoint, so a data migration is the correct production population path —
 * exactly like `CreateRoadmap` seeds `/about/roadmap` by importing its
 * `*.seed.ts`. We import the same seed constants the dev seed uses (single
 * source of truth, no transcription drift) and insert:
 *
 *  - the singleton `governance_overview` row (id = 'current'), and
 *  - every `governance_finance_report` row: the full Q2 2026 narrative report
 *    plus the five prior history quarters that back the admin Finances chart.
 *
 * Idempotent: `ON CONFLICT DO NOTHING` on the overview PK and the finance
 * report's unique `quarter`, so re-running (or running after a partial dev
 * seed) never duplicates or errors.
 */
export class SeedGovernanceContent1788600000000 implements MigrationInterface {
  name = 'SeedGovernanceContent1788600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // --- governance_overview (singleton) ---------------------------------
    await queryRunner.query(
      `INSERT INTO "governance_overview"
         ("id", "health", "moderation_steps", "council", "principles", "decisions")
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT ("id") DO NOTHING`,
      [
        governanceOverviewSeed.id,
        JSON.stringify(governanceOverviewSeed.health),
        JSON.stringify(governanceOverviewSeed.moderationSteps),
        JSON.stringify(governanceOverviewSeed.council),
        JSON.stringify(governanceOverviewSeed.principles),
        JSON.stringify(governanceOverviewSeed.decisions),
      ],
    );

    // --- governance_finance_report (Q2 2026 + history quarters) ----------
    // The full narrative report and the minimal history rows share the same
    // column set (history rows carry empty jsonb arrays / null reserve+partners
    // — see `financeHistorySeed`), so one insert loop covers both.
    for (const report of [governanceFinanceReportSeed, ...financeHistorySeed]) {
      await queryRunner.query(
        `INSERT INTO "governance_finance_report"
           ("quarter", "stats", "income", "expense", "event_notes",
            "reserve", "partners", "income_total", "expense_total",
            "surplus", "mrr", "sustainer_count", "solidarity_rate",
            "published_at")
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT ("quarter") DO NOTHING`,
        [
          report.quarter,
          JSON.stringify(report.stats),
          JSON.stringify(report.income),
          JSON.stringify(report.expense),
          JSON.stringify(report.eventNotes),
          report.reserve ? JSON.stringify(report.reserve) : null,
          report.partners ? JSON.stringify(report.partners) : null,
          report.incomeTotal,
          report.expenseTotal,
          report.surplus,
          report.mrr,
          report.sustainerCount,
          report.solidarityRate,
          report.publishedAt,
        ],
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    const quarters = [
      governanceFinanceReportSeed.quarter,
      ...financeHistorySeed.map((report) => report.quarter),
    ];
    await queryRunner.query(
      `DELETE FROM "governance_finance_report" WHERE "quarter" = ANY($1)`,
      [quarters],
    );
    await queryRunner.query(
      `DELETE FROM "governance_overview" WHERE "id" = $1`,
      [governanceOverviewSeed.id],
    );
  }
}
