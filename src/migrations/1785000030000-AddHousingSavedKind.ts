// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'housing' to the saved-item subject-type enum so housing listings can
 * be bookmarked. Postgres enums are not auto-altered (synchronize is off).
 * This migration only ADDS the value (never uses it in the same transaction),
 * so it is safe on PostgreSQL 12+. `down()` is a documented no-op: Postgres has
 * no `ALTER TYPE ... DROP VALUE`, and the value is harmless if left in place.
 * Plain `ADD VALUE` (no `IF NOT EXISTS`) matches this repo's migration
 * convention — CLAUDE.md discourages `IF [NOT] EXISTS` guards, since migrations
 * run exactly once against the ledger.
 */
export class AddHousingSavedKind1785000030000 implements MigrationInterface {
  name = 'AddHousingSavedKind1785000030000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "saved_item_subject_type_enum" ADD VALUE 'housing'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop an enum value. Leaving 'housing' in the enum
    // is harmless (no rows reference it once the saved rows are gone).
  }
}
