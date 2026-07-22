// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the performance-oriented persona kinds (drag performer, DJ, dancer,
 * performer, photographer, videomaker) and their content sections to the
 * subprofile enums. Postgres enums are not auto-altered (synchronize is off).
 *
 * This migration only ADDS values (never using them in the same transaction),
 * so it is safe on PostgreSQL 12+. Plain `ADD VALUE` (no `IF NOT EXISTS`)
 * matches this repo's convention — migrations run exactly once against the
 * ledger, so guards would only hide drift (see CLAUDE.md).
 *
 * `down()` is a documented no-op: Postgres has no `ALTER TYPE ... DROP VALUE`,
 * and the added values are harmless if left in place once no rows reference
 * them. New sections are validated against `KIND_SECTIONS` per kind, so
 * existing personas are unaffected.
 */
export class AddSubprofilePerformanceKinds1785000110000
  implements MigrationInterface
{
  name = 'AddSubprofilePerformanceKinds1785000110000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // New kinds on the subprofile kind enum.
    for (const kind of [
      'drag',
      'dj',
      'dancer',
      'performer',
      'photographer',
      'videomaker',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "subprofiles_kind_enum" ADD VALUE '${kind}'`,
      );
    }

    // New content sections on the subprofile-item section enum.
    for (const section of [
      'shows',
      'looks',
      'mixes',
      'performances',
      'reel',
      'appearances',
      'series',
      'videos',
    ]) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // No-op: Postgres cannot drop enum values. Leaving the new kinds/sections
    // in place is harmless once no rows reference them.
  }
}
