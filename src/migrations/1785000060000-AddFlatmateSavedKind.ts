// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'flatmate' to the saved-item subject-type enum so flatmate profiles can
 * be bookmarked. Only ADDS the value (safe on PostgreSQL 12+). Plain `ADD VALUE`
 * (no `IF NOT EXISTS`) matches this repo's migration convention. `down()` is a
 * documented no-op (Postgres cannot drop an enum value).
 */
export class AddFlatmateSavedKind1785000060000 implements MigrationInterface {
  name = 'AddFlatmateSavedKind1785000060000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'flatmate'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value; 'flatmate' is harmless if left.
  }
}
