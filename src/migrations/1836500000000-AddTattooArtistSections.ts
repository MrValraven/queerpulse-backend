// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Tattoo artist page: adds seven content sections to the subprofile section
 * enum. `subprofile_feeds.section` shares `subprofile_items_section_enum`, so
 * one enum change covers both tables. Only ADDs values and never uses them in
 * the same transaction, so it is safe on PostgreSQL 12+. Mirrors
 * `AddQuestPersonaKinds1822000000000`.
 */
const NEW_SECTIONS = [
  'cover_ups',
  'scar_work',
  'in_progress',
  'wanna_dos',
  'guest_spots',
  'flash_days',
  'shop',
];

export class AddTattooArtistSections1836500000000 implements MigrationInterface {
  name = 'AddTattooArtistSections1836500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const section of NEW_SECTIONS) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Failing loudly keeps the
    // migrations ledger honest.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
