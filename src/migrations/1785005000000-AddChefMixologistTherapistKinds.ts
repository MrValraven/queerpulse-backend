import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the hospitality/care persona kinds (chef, mixologist, therapist) and
 * their content sections to the subprofile enums. Postgres enums are not
 * auto-altered (synchronize is off), so the values are added explicitly —
 * mirroring `AddSubprofilePerformanceKinds1785000110000`.
 *
 * This migration only ADDS values (never using them in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention — migrations run exactly once against the
 * ledger, so guards would only hide drift (see CLAUDE.md).
 *
 * `down()` now throws instead of pretending to revert: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added values are harmless if left in place once no rows reference
 * them. New sections are validated against `KIND_SECTIONS` per kind, so
 * existing personas are unaffected.
 */
export class AddChefMixologistTherapistKinds1785005000000 implements MigrationInterface {
  name = 'AddChefMixologistTherapistKinds1785005000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New kinds on the subprofile kind enum.
    for (const kind of ['chef', 'mixologist', 'therapist']) {
      await queryRunner.query(
        `ALTER TYPE "subprofiles_kind_enum" ADD VALUE '${kind}'`,
      );
    }

    // New content sections on the subprofile-item section enum.
    for (const section of [
      'menus',
      'residencies',
      'cocktails',
      'specialisms',
      'credentials',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Not reversible: Postgres cannot drop enum values. Leaving the new kinds/sections
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
