// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the five article-blocks columns to `magazine_article` (Magazine Desk
 * redesign Phase 3, Task 2) that back the new `ArticleBlock` structured-body
 * system introduced on the entity in Task 1
 * (`magazine-article.entity.ts`): `standfirst`, `kicker`, `section`,
 * `contentNotes` -> `content_notes`, and `blocks`.
 *
 * All columns are `NOT NULL` with defaults so the migration is safe against
 * existing rows — no backfill step needed.
 *
 * UNAPPLIED — the maintainer runs `pnpm run migration:run`.
 */
export class AddArticleBlocks1786600000000 implements MigrationInterface {
  name = 'AddArticleBlocks1786600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        ADD COLUMN "standfirst" character varying NOT NULL DEFAULT '',
        ADD COLUMN "kicker" character varying NOT NULL DEFAULT '',
        ADD COLUMN "section" character varying NOT NULL DEFAULT '',
        ADD COLUMN "content_notes" text[] NOT NULL DEFAULT '{}',
        ADD COLUMN "blocks" jsonb NOT NULL DEFAULT '[]'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "magazine_article"
        DROP COLUMN "blocks",
        DROP COLUMN "content_notes",
        DROP COLUMN "section",
        DROP COLUMN "kicker",
        DROP COLUMN "standfirst"
    `);
  }
}
