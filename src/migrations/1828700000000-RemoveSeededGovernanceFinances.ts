import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-447 / PRD-448. Takes the invented governance figures off the public
 * Governance page.
 *
 * `SeedGovernanceContent1788600000000` inserted a fabricated Q2 2026 finance
 * report (named grant funders, "99 of 247 members contribute", an email vendor
 * for a platform that sends no email) plus five invented history quarters, and
 * six invented "Community health" tiles on the `governance_overview`
 * singleton. Production served all of it as the platform's accountability
 * record.
 *
 * Three steps, so figures an admin entered survive and invented content does
 * not:
 *
 *  1. DELETE. A finance report goes when its quarter AND all five headline
 *     figures still equal the seed's AND all five provenance columns still
 *     read `seeded` (`AddGovernanceFinanceProvenance1788800000000`). An edit to
 *     a ledger note or toggle stamps `metrics_edited_at` without touching a
 *     headline figure, so that stamp is deliberately ignored here.
 *  2. SCRUB every report that survives (any quarter): partners naming the two
 *     real organisations are emptied; stat tiles, event notes and the reserve
 *     go when they still equal the seed; every ledger line loses its seeded
 *     line items and total label (no admin path writes those); and a line
 *     note naming a real organisation, the invented membership count or a
 *     real vendor is blanked.
 *  3. HEALTH. The tiles are emptied unless `governance_overview_changes`
 *     holds a health edit, whatever they say. The rest of the singleton
 *     (moderation steps, council, principles, decisions) is platform policy
 *     and stays.
 *
 * The seed values are written out here on purpose. Importing them from the
 * `*.seed.ts` files would tie this migration's matching to whatever those dev
 * fixtures say on the day it runs.
 */

/** The six seeded quarters and their exact headline figures. */
const SEEDED_FINANCE_QUARTERS = [
  {
    quarter: '2026-Q2',
    incomeTotal: 4620,
    expenseTotal: 4150,
    mrr: 1840,
    sustainerCount: 99,
    solidarityRate: 11,
  },
  {
    quarter: '2025-Q1',
    incomeTotal: 3560,
    expenseTotal: 3480,
    mrr: 1320,
    sustainerCount: 71,
    solidarityRate: 14,
  },
  {
    quarter: '2025-Q2',
    incomeTotal: 3820,
    expenseTotal: 3690,
    mrr: 1440,
    sustainerCount: 78,
    solidarityRate: 13,
  },
  {
    quarter: '2025-Q3',
    incomeTotal: 4080,
    expenseTotal: 3900,
    mrr: 1560,
    sustainerCount: 84,
    solidarityRate: 13,
  },
  {
    quarter: '2025-Q4',
    incomeTotal: 4290,
    expenseTotal: 4020,
    mrr: 1680,
    sustainerCount: 90,
    solidarityRate: 12,
  },
  {
    quarter: '2026-Q1',
    incomeTotal: 4240,
    expenseTotal: 4010,
    mrr: 1760,
    sustainerCount: 95,
    solidarityRate: 12,
  },
];

/** Seeded tiles, notes and reserve, exactly as the seed stored them. The em
 *  dash in the last note is written as a `\u2014` escape. */
const SEEDED_STATS = [
  {
    n: '€4,620',
    l: 'Total income this quarter',
    trend: '↑ €380 vs Q1',
    up: true,
  },
  { n: '€4,150', l: 'Total expenditure', trend: 'Within budget', up: false },
  { n: '€470', l: 'Quarterly surplus', trend: 'Added to reserve', up: false },
  {
    n: '28',
    l: 'Members on free or reduced access',
    trend: 'No questions asked',
    up: false,
  },
];

const SEEDED_EVENT_NOTES = [
  {
    title: 'Hosts keep 100% of ticket sales.',
    body: 'QueerPulse charges no platform fee. Sell 20 tickets at €8, you receive €160.',
  },
  {
    title: 'Sliding scale is mandatory.',
    body: 'Every paid gathering must offer a reduced rate. Members request it privately, no explanation asked.',
  },
  {
    title: 'QueerPulse subsidises specific event types.',
    body: 'Newcomer, mental health, and education events can apply for a venue subsidy. We covered 7 this quarter.',
  },
  {
    title: 'No paid promotion.',
    body: 'Events are never ranked by payment. Only recency and community engagement affect visibility.',
  },
  {
    title: 'This quarter:',
    body: '34 gatherings hosted. ~€8,400 in ticket revenue \u2014 all of which went directly to hosts.',
  },
];

const SEEDED_RESERVE = { current: 4380, target: 12450 };

/** A line note matching this was written by the seed. */
const SEEDED_NOTE_PATTERN = 'Gulbenkian|ILGA|99 of 247|Postmark|GitHub';

/** Partners naming the two real organisations the seed invented grants from. */
const SEEDED_PARTNER_PATTERN = 'Gulbenkian|ILGA';

export class RemoveSeededGovernanceFinances1828700000000 implements MigrationInterface {
  name = 'RemoveSeededGovernanceFinances1828700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // ── 1. Delete the seeded quarters ────────────────────────────────────
    for (const seeded of SEEDED_FINANCE_QUARTERS) {
      await queryRunner.query(
        `DELETE FROM "governance_finance_report"
          WHERE "quarter" = $1
            AND "income_total" = $2
            AND "expense_total" = $3
            AND "mrr" = $4
            AND "sustainer_count" = $5
            AND "solidarity_rate" = $6
            AND "mrr_source" = 'seeded'
            AND "sustainer_count_source" = 'seeded'
            AND "solidarity_rate_source" = 'seeded'
            AND "income_total_source" = 'seeded'
            AND "expense_total_source" = 'seeded'`,
        [
          seeded.quarter,
          seeded.incomeTotal,
          seeded.expenseTotal,
          seeded.mrr,
          seeded.sustainerCount,
          seeded.solidarityRate,
        ],
      );
    }

    // ── 2. Scrub what survives ───────────────────────────────────────────
    await queryRunner.query(
      `UPDATE "governance_finance_report"
          SET "partners" = '[]'::jsonb
        WHERE "partners"::text ~* $1`,
      [SEEDED_PARTNER_PATTERN],
    );
    await queryRunner.query(
      `UPDATE "governance_finance_report"
          SET "stats" = '[]'::jsonb
        WHERE "stats" = $1::jsonb`,
      [JSON.stringify(SEEDED_STATS)],
    );
    await queryRunner.query(
      `UPDATE "governance_finance_report"
          SET "event_notes" = '[]'::jsonb
        WHERE "event_notes" = $1::jsonb`,
      [JSON.stringify(SEEDED_EVENT_NOTES)],
    );
    await queryRunner.query(
      `UPDATE "governance_finance_report"
          SET "reserve" = NULL
        WHERE "reserve" = $1::jsonb`,
      [JSON.stringify(SEEDED_RESERVE)],
    );
    // Each ledger line (`FinanceLine`: label, amount, note, width, items,
    // total, source?, enabled?) keeps its own figures and loses the seeded
    // breakdown. `WITH ORDINALITY` keeps the rows in their stored order.
    for (const column of ['income', 'expense']) {
      await queryRunner.query(
        `UPDATE "governance_finance_report"
            SET "${column}" = (
              SELECT COALESCE(
                jsonb_agg(
                  entry.line || jsonb_build_object(
                    'items', '[]'::jsonb,
                    'total', jsonb_build_object(
                      'label', '',
                      'amount', COALESCE(entry.line->'amount', to_jsonb(''::text))
                    ),
                    'note', CASE
                      WHEN COALESCE(entry.line->>'note', '') ~* $1
                        THEN to_jsonb(''::text)
                      ELSE COALESCE(entry.line->'note', to_jsonb(''::text))
                    END
                  )
                  ORDER BY entry.position
                ),
                '[]'::jsonb
              )
              FROM jsonb_array_elements("${column}")
                WITH ORDINALITY AS entry(line, position)
            )
          WHERE jsonb_typeof("${column}") = 'array'`,
        [SEEDED_NOTE_PATTERN],
      );
    }

    // ── 3. Health tiles ──────────────────────────────────────────────────
    // Emptied unless someone saved the health section. The public read
    // applies the same rule (`GovernanceOverviewService.getOverview`), so a
    // tile nobody entered never reaches the page either way.
    await queryRunner.query(
      `UPDATE "governance_overview"
          SET "health" = '[]'::jsonb
        WHERE "id" = 'current'
          AND NOT EXISTS (
            SELECT 1 FROM "governance_overview_changes"
             WHERE "section" = 'health'
          )`,
    );
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. Putting the invented figures back would republish
    // fabricated accounts on a public page, which is the bug `up` fixes.
  }
}
