import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_article` had no index on `published_at` although every public read
 * of the magazine filters and orders on exactly that column (`BE-CNT-13`):
 * `MagazineService.listArticles`, `searchByText` and
 * `searchPublishedArticlesForArchive` all issue
 * `WHERE published_at IS NOT NULL AND published_at <= now ORDER BY published_at DESC`.
 * Without an index that is a sequential scan plus an in-memory sort over the
 * heaviest table in the module — the rows carry the whole `blocks` jsonb and
 * the legacy `body` text — on every magazine index and search request.
 *
 * The sibling tables already had theirs (`IDX_magazine_deck_published_at`,
 * `IDX_cinema_titles_published_at`); the article table was simply missed.
 *
 * PARTIAL and DESC on purpose. Unpublished drafts are the rows a working desk
 * accumulates most of and no public query ever wants them, so
 * `WHERE published_at IS NOT NULL` keeps the index to the rows that are
 * actually read; `DESC` matches the sort direction every one of those queries
 * asks for, so the plan can walk the index instead of sorting.
 *
 * The matching `@Index` decorator lives on `MagazineArticle.publishedAt` so a
 * future `migration:generate` diff does not see drift.
 */
export class AddMagazineArticlePublishedAtIndex1793540200000 implements MigrationInterface {
  name = 'AddMagazineArticlePublishedAtIndex1793540200000';

  // CONCURRENTLY cannot run inside a transaction block (PostgreSQL manual,
  // "CREATE INDEX"). `migrationsTransactionMode: 'each'` (data-source.ts) is
  // what lets this migration opt out per-migration rather than being folded
  // into one shared batch transaction. This file therefore holds NOTHING but
  // the concurrent index.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_magazine_article_published_at" ` +
        `ON "magazine_article" ("published_at" DESC) ` +
        `WHERE "published_at" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_magazine_article_published_at"`,
    );
  }
}
