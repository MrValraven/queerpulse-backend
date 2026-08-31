import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `pole_dancer` persona kind to the subprofile kind enum. Postgres
 * enums are not auto-altered (synchronize is off), so the value is added
 * explicitly — mirroring `AddAstrologerKind1787700300000`.
 *
 * No section enum change is needed: `pole_dancer` reuses existing sections
 * (`performances`, `classes`, `reel`, `workshops`), all already present in
 * `subprofile_items_section_enum`.
 *
 * This migration only ADDS a value (never using it in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention.
 *
 * `down()` now throws instead of pretending to revert: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added value is harmless if left in place once no rows reference it.
 */
export class AddPoleDancerKind1787700600000 implements MigrationInterface {
  name = 'AddPoleDancerKind1787700600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "subprofiles_kind_enum" ADD VALUE 'pole_dancer'`,
    );
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop enum values. Leaving the new kind in place
    // is harmless once no rows reference it.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
