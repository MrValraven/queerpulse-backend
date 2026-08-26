// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The GIN index that makes `magazine_article.search_vector` (added in
 * `1794833600000-AddMagazineArticleSearchVector`) worth having.
 *
 * Without it every `search_vector @@ to_tsquery(...)` is a sequential scan
 * that recheck-filters each row's vector, which is what the magazine's
 * previous `ILIKE '%term%'` did anyway. GIN is the right access method for
 * `tsvector @@ tsquery`: the inverted index maps each lexeme straight to the
 * rows carrying it ("GIN Indexes", PostgreSQL manual), so a search touches
 * only candidate articles instead of the whole table.
 *
 * SEPARATE FILE ON PURPOSE. `CREATE INDEX CONCURRENTLY` cannot run inside a
 * transaction block, and the column migration must stay transactional (a
 * half-applied `ADD COLUMN ... GENERATED` is not something to leave behind).
 * Splitting them is the same two-phase shape
 * `1785700100000-AddSearchTrgmAndTagsIndexes` uses. Run this one with:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * (`transaction = false` below is honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`.)
 *
 * Ordering matters: this migration's timestamp is after the column's, so a
 * fresh database creates the column first and this never indexes a column
 * that does not exist yet.
 */
export class AddMagazineArticleSearchVectorIndex1794833610000 implements MigrationInterface {
  name = 'AddMagazineArticleSearchVectorIndex1794833610000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`. Re-runnability
  // comes from the deploy preflight dropping invalid indexes, not from an
  // `IF NOT EXISTS` guard (which would hide schema drift).
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_magazine_article_search_vector" ` +
        `ON "magazine_article" USING gin ("search_vector")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_magazine_article_search_vector"`,
    );
  }
}
