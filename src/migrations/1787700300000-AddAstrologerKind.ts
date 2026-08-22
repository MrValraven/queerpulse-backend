// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the `astrologer` persona kind and its content sections (`charts`, `sky`)
 * to the subprofile enums. Postgres enums are not auto-altered (synchronize is
 * off), so the values are added explicitly — mirroring
 * `AddChefMixologistTherapistKinds1785005000000`.
 *
 * This migration only ADDS values (never using them in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention — migrations run exactly once against the
 * ledger, so guards would only hide drift (see CLAUDE.md).
 *
 * The chart skin's per-persona blocks (`sky`/`birthData`/`ethics`) live in the
 * existing freeform `skin_data` jsonb column, so they need no schema change —
 * only the `SkinData` interface on the entity gained the optional fields.
 *
 * `down()` now throws instead of pretending to revert: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added values are harmless if left in place once no rows reference
 * them.
 */
export class AddAstrologerKind1787700300000 implements MigrationInterface {
  name = 'AddAstrologerKind1787700300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New kind on the subprofile kind enum.
    await queryRunner.query(
      `ALTER TYPE "subprofiles_kind_enum" ADD VALUE 'astrologer'`,
    );

    // New content sections on the subprofile-item section enum.
    for (const section of ['charts', 'sky']) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop enum values. Leaving the new kind/sections
    // in place is harmless once no rows reference them.
    // Fails loudly rather than reporting a successful revert that undid
    // nothing: a silent no-op removes the row from the migrations ledger, so
    // the next `migration:run` retries `ADD VALUE` and errors on the label
    // that is still there. Postgres has no `ALTER TYPE ... DROP VALUE`.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
