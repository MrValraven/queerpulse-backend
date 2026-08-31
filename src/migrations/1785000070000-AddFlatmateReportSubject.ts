import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'flatmate' to the reports subject-type enum so flatmate profiles can be
 * reported. Only ADDS the value (safe on PostgreSQL 12+); plain `ADD VALUE`
 * matches repo convention. Reasons are code-side (existing codes reused, no DB
 * change — `reason_code` is a free `varchar`). `down()` is a documented no-op.
 */
export class AddFlatmateReportSubject1785000070000 implements MigrationInterface {
  name = 'AddFlatmateReportSubject1785000070000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'flatmate'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop an enum value; 'flatmate' is harmless if left.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
