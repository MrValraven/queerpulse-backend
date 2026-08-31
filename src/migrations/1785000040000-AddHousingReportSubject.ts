import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'housing' to the reports subject-type enum so housing listings can be
 * reported. Only ADDS the value (never uses it in the same transaction), so it
 * is safe on PostgreSQL 12+. `down()` is a documented no-op (Postgres has no
 * `ALTER TYPE ... DROP VALUE`). Reason codes / severity are code-side (no DB
 * column change — `reason_code` is a free `varchar`). Plain `ADD VALUE` (no
 * `IF NOT EXISTS`) matches this repo's migration convention.
 */
export class AddHousingReportSubject1785000040000 implements MigrationInterface {
  name = 'AddHousingReportSubject1785000040000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'housing'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; 'housing' is harmless if left.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
