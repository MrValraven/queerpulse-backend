import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'event', 'business', 'company', 'job', and 'subprofile' to the reports
 * subject-type enum so a member can report an event (`myevents`), a
 * business-directory business/company/job posting (`economy`), and a member
 * subprofile/persona. Mirrors `AddListingReportSubject1785002400000` exactly:
 * each value is only ADDED (never used in the same transaction), so it is safe
 * on PostgreSQL 12+ where `ALTER TYPE ... ADD VALUE` may run inside the
 * migration transaction. `down()` is a documented no-op (Postgres has no
 * `ALTER TYPE ... DROP VALUE`). Reason codes / severity are code-side (no DB
 * column change — `reason_code` is a free `varchar`). Plain `ADD VALUE`
 * (no `IF NOT EXISTS`) matches this repo's migration convention.
 */
export class AddEventBusinessCompanyJobSubprofileReportSubjects1785002700000 implements MigrationInterface {
  name = 'AddEventBusinessCompanyJobSubprofileReportSubjects1785002700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'event'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'business'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'company'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'job'`,
    );
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'subprofile'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; the added values are harmless
    // if left in place.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
