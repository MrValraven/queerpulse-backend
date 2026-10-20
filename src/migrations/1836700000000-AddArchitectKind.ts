// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Architect persona: adds the `architect` kind to `subprofiles_kind_enum` and
 * its two new content sections (built_work, competitions) to
 * `subprofile_items_section_enum`. `subprofile_feeds.section` shares that
 * section enum, so one change covers both tables. The kind's third section,
 * `projects`, already exists and is left alone: `ALTER TYPE ... ADD VALUE`
 * errors on a label that is already present.
 *
 * Only ADDs values and never uses them in the same transaction, so it is safe
 * on PostgreSQL 12+. Mirrors `AddVideoAndAudioCreatorKinds1827800050000` and
 * `AddTattooArtistSections1836500000000`.
 */
const NEW_KINDS = ['architect'];

const NEW_SECTIONS = ['built_work', 'competitions'];

export class AddArchitectKind1836700000000 implements MigrationInterface {
  name = 'AddArchitectKind1836700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const kind of NEW_KINDS) {
      await queryRunner.query(
        `ALTER TYPE "subprofiles_kind_enum" ADD VALUE '${kind}'`,
      );
    }
    for (const section of NEW_SECTIONS) {
      await queryRunner.query(
        `ALTER TYPE "subprofile_items_section_enum" ADD VALUE '${section}'`,
      );
    }
  }

  public async down(): Promise<void> {
    // Postgres has no `ALTER TYPE ... DROP VALUE`. Failing loudly keeps the
    // migrations ledger honest; a silent no-op would make the next run retry
    // `ADD VALUE` and error on labels that are still there.
    throw new Error(
      'Irreversible: Postgres cannot drop an enum value. Restore from a backup instead.',
    );
  }
}
