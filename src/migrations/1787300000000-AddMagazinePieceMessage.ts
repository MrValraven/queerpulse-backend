// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `magazine_piece_message` (Magazine Desk Phase 7, Task F1): a per-piece
 * editor↔writer message thread, visible/postable only to the piece's
 * assigned editor/admin or its assigned writer (enforced in
 * `MagazinePieceService`, not by the schema).
 *
 * No `FOREIGN KEY` constraint on `piece_id`: mirrors
 * `AddMagazineArticleComment`/`AddMagazineArticleVersion` — the entity
 * (`magazine-piece-message.entity.ts`) models `pieceId` as a plain indexed
 * `uuid` column, not a TypeORM relation.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddMagazinePieceMessage1787300000000 implements MigrationInterface {
  name = 'AddMagazinePieceMessage1787300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_piece_message" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "piece_id" uuid NOT NULL,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_piece_message" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_piece_message_piece" ON "magazine_piece_message" ("piece_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_piece_message"`);
  }
}
