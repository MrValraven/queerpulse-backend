// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'landlord' to the saved-item subject-type enum. Only ADDS the value (safe
 * on PostgreSQL 12+); plain `ADD VALUE` matches repo convention. `down()` is a
 * documented no-op (Postgres cannot drop an enum value).
 */
export class AddLandlordSavedKind1785000090000 implements MigrationInterface {
  name = 'AddLandlordSavedKind1785000090000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'landlord'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; 'landlord' is harmless if left.
  }
}
