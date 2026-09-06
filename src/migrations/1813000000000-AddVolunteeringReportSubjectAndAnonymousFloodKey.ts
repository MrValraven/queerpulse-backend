// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two changes to `reports`, both belonging to the same slice of work (section
 * 11 of the 2026-09-05 deep scan) and both landing on the same table.
 *
 * ## 1. `volunteering` joins `reports_subject_type_enum` (PRD-283)
 *
 * A volunteering opportunity could not be reported at all. Nothing in the
 * subject taxonomy reached `volunteer_opportunities`, so the only way to raise
 * a scam posting, an unsafe placement or a host organization that is not
 * affirming was the Contact form, which is a different queue and carries no
 * subject a moderator can act on.
 *
 * `job` is the nearest-looking neighbour and it is the wrong one: a `job`
 * subject is a slug in the PAID-work directory (`src/companies`), a different
 * table entirely, so a moderator acting on one would have been acting on
 * nothing. Addressed by the opportunity's SLUG, matching `GET /volunteering/
 * :slug` and the public opportunity page, so what the reporter's browser
 * already holds is what the report carries.
 *
 * Reason codes are code-side (`reports.reason_code` is a free `varchar`), so
 * `SUBJECT_REASONS` in `reason-catalogue.ts` is the only other backend change
 * this value forces; that map is a total `Record<ReportSubjectType, ...>`, so
 * the value could not be added without it. The frontend mirror in
 * `queerpulse/src/features/safety/reportReasons.ts` is a total `Record` for the
 * same reason. Follows `AddPhotoAndRecommendationReportSubjects1797700000000`
 * exactly.
 *
 * ## 2. `anonymous_reporter_key` (PRD-280)
 *
 * `POST /reports` is now public: a signed-out person can file. That takes two
 * of the three anti-flood layers off the table, because both are keyed on
 * `reporter_id`, which is NULL for such a filing. The open-report dedupe stops
 * binding (Postgres treats NULLs as distinct in the partial unique index) and
 * the rolling per-member caps stop binding (there is no member).
 *
 * This column is what the replacement caps count. It holds an HMAC-SHA256 hex
 * digest of the reporter's client address under a server-held pepper
 * (`REPORT_ANONYMOUS_FLOOD_PEPPER`) and never the address itself, exactly as
 * `removed_account_signals` treats an email address: the people this column
 * describes are the ones who deliberately chose not to have an account, so a
 * one-way stored form is the whole basis on which storing anything is
 * defensible. `reports/anonymous-reporter-key.ts` derives it and is blunt
 * about how much weaker a network address is than an account id;
 * `reports/report-flood-limits.ts` carries the caps and their sizes.
 *
 * NULL on every signed-in report, and NULL is also what a signed-out filing
 * stores when no client address could be read. The caps treat NULL as
 * "uncapped by this layer" rather than refusing, because turning away a safety
 * report over a proxy configuration is the worse failure.
 *
 * The index is PARTIAL for that reason: the column is NULL on the bulk of the
 * table, and indexing those rows would cost an entry per insert and serve no
 * read. Shaped (key, created_at) like `IDX_reports_reporter_created_at`, which
 * does the same job for the per-member caps. The daily count is a clean range
 * scan, and the per-subject count reuses the same range and filters the
 * subject columns over what the daily cap has already bounded. NOT unique: two
 * filings under one key are exactly what the caps count, so they have to be
 * allowed to exist.
 *
 * ## Transaction mode
 *
 * Plain transactional, all three statements together.
 *
 * `ADD VALUE` is safe inside the migration transaction on PostgreSQL 12+ so
 * long as nothing in the SAME transaction USES the new label, and nothing here
 * does: neither the column nor the index below mentions `volunteering`.
 *
 * The index is built WITHOUT `CONCURRENTLY`, which departs from
 * `AddReportsReporterCreatedAtIndex1795710000000` on this same table, and the
 * difference is the point. That one indexed an existing, fully populated
 * column, so its build had to read and write an entry for every row in a table
 * carrying live traffic, and it opted out of the transaction to avoid holding
 * writes for the duration. This one indexes a column added three lines above
 * it, whose predicate therefore matches zero rows: the build allocates an
 * empty index after a single sequential scan, and the `SHARE` lock it takes on
 * `reports` is held for that scan alone.
 *
 * Staying transactional is worth that scan. `CREATE INDEX CONCURRENTLY` cannot
 * run in a transaction block, so going that way would mean `transaction =
 * false` across an `ADD VALUE` and an `ADD COLUMN` as well, and a failure part
 * way through would leave the enum label or the column applied with no ledger
 * row behind them. The re-run would then fail on objects that already exist,
 * which is precisely the ledger mismatch this repository's guidance says to
 * avoid creating.
 */
export class AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000 implements MigrationInterface {
  name = 'AddVolunteeringReportSubjectAndAnonymousFloodKey1813000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'volunteering'`,
    );
    await queryRunner.query(
      `ALTER TABLE "reports" ADD COLUMN "anonymous_reporter_key" character varying(64)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_reports_anonymous_reporter_key" ` +
        `ON "reports" ("anonymous_reporter_key", "created_at") ` +
        `WHERE "anonymous_reporter_key" IS NOT NULL`,
    );
  }

  public async down(): Promise<void> {
    // Fails loudly rather than reporting a successful revert that undid
    // nothing. Postgres has no `ALTER TYPE ... DROP VALUE`, so the enum half of
    // this migration is irreversible whatever happens to the column, and a
    // partial revert that dropped the column while leaving the label would
    // still remove the row from the migrations ledger, and the next
    // `migration:run` would then retry `ADD VALUE` and error on a label that is
    // still there. Mirrors
    // `AddPhotoAndRecommendationReportSubjects1797700000000`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
