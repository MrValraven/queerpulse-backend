import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `magazine_article_version` (Magazine Desk Phase 7, Task E1): a
 * point-in-time snapshot of a `MagazineArticle`'s `blocks`, written on file,
 * on an explicit manual save, and (twice) on restore.
 *
 * No `FOREIGN KEY` constraint on `article_id`: mirrors
 * `AddMagazineArticleComment`/`AddMagazinePieceRecord` — the entity
 * (`magazine-article-version.entity.ts`) models `articleId` as a plain
 * indexed `uuid` column, not a TypeORM relation.
 */
export class AddMagazineArticleVersion1787200000000 implements MigrationInterface {
  name = 'AddMagazineArticleVersion1787200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "magazine_article_version" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "article_id" uuid NOT NULL,
        "label" character varying NOT NULL,
        "author_id" uuid,
        "blocks" jsonb NOT NULL DEFAULT '[]',
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_magazine_article_version" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_magazine_article_version_article" ON "magazine_article_version" ("article_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "magazine_article_version"`);
  }
}
