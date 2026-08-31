import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `contents_blurb` to `magazine_piece` (Magazine Desk Phase 7, Task B2):
 * the per-piece blurb edited on the issue's Cover & Contents tab. Defaults
 * every existing and new row to `''` — matches the repo idiom of a plain
 * `varchar` with a blank default for free-text fields filled in later (see
 * `MagazinePiece.byline`).
 */
export class AddPieceContentsBlurb1787000000000 implements MigrationInterface {
  name = 'AddPieceContentsBlurb1787000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_piece"
        ADD COLUMN "contents_blurb" varchar NOT NULL DEFAULT ''
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_piece"
        DROP COLUMN "contents_blurb"
    `);
  }
}
