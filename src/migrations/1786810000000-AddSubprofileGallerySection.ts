// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the universal `gallery` content section (up to 6 photos, enforced in
 * `SubprofilesService.replaceSection`) to the subprofile-item section enum.
 * Every persona kind gets it via `sectionsForKind` (`../subprofile-kinds.ts`),
 * appended just before the universal `links` section. Postgres enums are not
 * auto-altered (synchronize is off).
 *
 * This migration only ADDS a value (never using it in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention — migrations run exactly once against the
 * ledger, so guards would only hide drift (see CLAUDE.md).
 *
 * `down()` is a documented no-op: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added value is harmless if left in place once no rows reference it.
 */
export class AddSubprofileGallerySection1786810000000 implements MigrationInterface {
  name = 'AddSubprofileGallerySection1786810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "subprofile_items_section_enum" ADD VALUE 'gallery'`,
    );
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop enum values. Leaving the new section in
    // place is harmless once no rows reference it.
  }
}
