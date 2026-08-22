// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds 'housing' to the saved-item subject-type enum so housing listings can
 * be bookmarked. Postgres enums are not auto-altered (synchronize is off).
 * This migration only ADDS the value (never uses it in the same transaction),
 * so it is safe on PostgreSQL 12+. `down()` now throws instead of pretending to revert: Postgres has
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
    // Not reversible: Postgres cannot drop an enum value. Leaving 'housing' in the enum
    // is harmless, but the ledger must not claim it was undone.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
