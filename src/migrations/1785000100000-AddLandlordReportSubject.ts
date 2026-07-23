// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'landlord' to the reports subject-type enum. Only ADDS the value (safe on
 * PostgreSQL 12+); plain `ADD VALUE` matches repo convention. Reasons reuse
 * existing codes (no DB change). `down()` is a documented no-op.
 */
export class AddLandlordReportSubject1785000100000 implements MigrationInterface {
  name = 'AddLandlordReportSubject1785000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "reports_subject_type_enum" ADD VALUE 'landlord'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; 'landlord' is harmless if left.
  }
}
