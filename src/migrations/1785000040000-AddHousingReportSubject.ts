// DO NOT RUN — authored for review only; the maintainer runs migrations.
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
    // No-op: Postgres cannot drop an enum value; 'housing' is harmless if left.
  }
}
