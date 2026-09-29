// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `subprofiles.edit_version` (ENG-451): the persona editor's save
 * precondition. The four editor writes (PATCH, section PUT, social-links PUT,
 * affiliations PUT) each raise it by 1 under the persona row lock, and a write
 * whose `expectedEditVersion` no longer matches it gets a 409
 * `PERSONA_EDIT_CONFLICT`, so two co-owners (or two tabs) saving at once can
 * no longer silently overwrite each other.
 *
 * Backfill: every existing row starts at 0 through the column default. An
 * editor already open when this runs loaded no version and sends none, so its
 * next save passes and raises the counter.
 */
export class AddSubprofileEditVersion1824720000000 implements MigrationInterface {
  name = 'AddSubprofileEditVersion1824720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" ADD "edit_version" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "subprofiles" DROP COLUMN "edit_version"`,
    );
  }
}
