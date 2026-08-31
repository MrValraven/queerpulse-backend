import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `magazine_article_comment` (Magazine Desk Phase 7, Task D1): threaded,
 * resolvable comments anchored to a `MagazineArticle`, optionally scoped to
 * one block (`block_id`) and optionally a reply to a top-level comment
 * (`parent_id`).
 *
 * No `FOREIGN KEY` constraints are declared: mirrors `AddMagazinePieceRecord`
 * and `AddMagazinePieces` — the entity (`magazine-article-comment.entity.ts`)
 * models `articleId`/`parentId` as plain indexed `uuid` columns, not a
 * TypeORM relation.
 */
export class AddMagazineArticleComment1787100000000 implements MigrationInterface {
  name = 'AddMagazineArticleComment1787100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_article_comment" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "article_id" uuid NOT NULL,
        "block_id" character varying,
        "parent_id" uuid,
        "author_id" uuid NOT NULL,
        "body" text NOT NULL,
        "resolved" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_article_comment" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_comment_article" ON "magazine_article_comment" ("article_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_comment_parent" ON "magazine_article_comment" ("parent_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_article_comment"`);
  }
}
