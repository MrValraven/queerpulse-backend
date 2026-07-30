// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'listing' to the saved-item subject-type enum. Only ADDS the value (safe
 * on PostgreSQL 12+); plain `ADD VALUE` matches repo convention. `down()` is a
 * documented no-op (Postgres cannot drop an enum value).
 */
export class AddListingSavedKind1785002200000 implements MigrationInterface {
  name = 'AddListingSavedKind1785002200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'listing'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; 'listing' is harmless if left.
  }
}
