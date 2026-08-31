import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Optimistic-concurrency counter for the magazine article draft body
 * (`BE-CNT-03`).
 *
 * The article editor autosaves partial patches — `blocks` included — and the
 * desk is deliberately multi-actor: the assigned writer files a draft into the
 * same row an editor is editing, and a sensitivity reader may have a third tab
 * open. Every one of those writes was last-write-wins on a whole `blocks`
 * array, so one autosave silently discarded the other's paragraphs, and a tab
 * left open across a "Restore version" quietly wrote its pre-restore blocks
 * back over the restore. Autosaves are never snapshotted, so what was lost was
 * unrecoverable.
 *
 * `MagazinePieceService.saveArticleDraftGuarded` now writes the draft under an
 * `UPDATE ... WHERE id = :id AND version = :baseVersion` precondition and
 * returns 409 when it matches no row. Existing rows start at 0, which is what
 * the freshly-added column defaults to, so no backfill is needed.
 *
 * Named `...VersionColumn` rather than `...Version` because
 * `1787200000000-AddMagazineArticleVersion` (the `magazine_article_version`
 * SNAPSHOT table) already owns that name — two different things, and a
 * migration's class name is its identity in the ledger.
 */
export class AddMagazineArticleVersionColumn1793540000000 implements MigrationInterface {
  name = 'AddMagazineArticleVersionColumn1793540000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        ADD COLUMN "version" integer NOT NULL DEFAULT 0
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        DROP COLUMN "version"
    `);
  }
}
