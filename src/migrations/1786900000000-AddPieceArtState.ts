import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `art` to `magazine_piece` (Magazine Desk Phase 7, Task A3): the
 * tracked art-workflow state (`'none' | 'brief' | 'in' | 'na'`, see
 * `ArtState` on the entity) behind the desk's `v-art` saved view. Defaults
 * every existing and new row to `'none'` — a plain `varchar`, matching the
 * repo idiom of no Postgres `CREATE TYPE` for string-union "enums" (see
 * `MagazinePiece.format`/`stage`).
 */
export class AddPieceArtState1786900000000 implements MigrationInterface {
  name = 'AddPieceArtState1786900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_piece"
        ADD COLUMN "art" varchar NOT NULL DEFAULT 'none'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_piece"
        DROP COLUMN "art"
    `);
  }
}
