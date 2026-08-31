import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimistic-concurrency counter for `draft` (`BE-CNT-11`).
 *
 * A draft is an autosaving surface a member can legitimately have open twice
 * (two tabs, or a phone and a laptop), and `DraftsService.update` MERGES a
 * partial patch onto the stored payload — so two interleaved saves resolved
 * last-write-wins with the loser's edits gone and nothing to say so. The
 * service now writes under an `UPDATE ... WHERE version = :expected`
 * precondition and returns 409 when it matches no row.
 *
 * Existing rows start at 0, which is the column default, so no backfill is
 * needed.
 */
export class AddDraftVersion1793540300000 implements MigrationInterface {
  name = 'AddDraftVersion1793540300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "draft"
        ADD COLUMN "version" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "draft"
        DROP COLUMN "version"
    `);
  }
}
