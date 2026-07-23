// DO NOT RUN — authored for review only; the maintainer runs migrations.
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
    // No-op: Postgres cannot drop an enum value; 'flatmate' is harmless if left.
  }
}
