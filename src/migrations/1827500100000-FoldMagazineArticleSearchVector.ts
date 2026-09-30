// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-503. Accent-folds `magazine_article.search_vector`, so a reader who
 * types "saude", "Principe Real" or "Joao" finds the piece spelled "saúde",
 * "Príncipe Real" or "João", and "são" finds "Sao".
 *
 * The column from `AddMagazineArticleSearchVector1794833600000` handed each
 * field straight to `to_tsvector('english', ...)`. The `english` parser keeps
 * diacritics, so "saúde" was stored as the lexeme `saúd` and a reader typing
 * without accents (most phone keyboards, most of the time) matched nothing.
 *
 * WHAT CHANGES
 * Every text input is wrapped in the same `translate(lower(...))` fold the
 * rest of platform search uses (`foldedTextExpression` in
 * `connections/connection-search.ts`, re-exported by `search/search-text.ts`).
 * The field list, the A/B/D weights and the `english` configuration are
 * exactly as before: readers rely on its stemming today. The needle is folded
 * with the same character pairs in `toPrefixTsQuery`
 * (`magazine/magazine-search-query.ts`, via `foldSearchText`), so both sides
 * of `@@` agree character for character.
 *
 * The fold is spelled out literally here. A migration is frozen history, and
 * importing the helper would let a later edit to it silently change what this
 * file claims to have built.
 *
 * `translate()` and `lower()` are both IMMUTABLE, so the generation
 * expression stays legal; the two helper functions from the original
 * migration are reused untouched.
 *
 * WHY DROP AND RE-ADD
 * Postgres below 17 has no way to change a generated column's expression in
 * place, so the index and the column are dropped and rebuilt. The column is
 * STORED, so the re-add rewrites the table and recomputes every row's vector
 * with the new expression; no backfill is needed.
 *
 * LOCKING AND THE INDEX
 * One transactional migration. `ALTER TABLE` already holds ACCESS EXCLUSIVE on
 * `magazine_article` for the rewrite, so building the GIN index in the same
 * transaction adds no extra blocking, and it keeps the swap atomic: a failure
 * anywhere rolls back to the old column and index, which is what readers keep
 * searching against. `CONCURRENTLY` (used by the original
 * `AddMagazineArticleSearchVectorIndex1794833610000`) cannot run inside a
 * transaction, and on an editorial table of hundreds of rows it would buy
 * nothing: splitting it out would leave a window with the column and no index.
 * The index definition itself is identical to the original.
 */

// The fold pair from `connections/connection-search.ts`, frozen at the value
// this migration was written against. `search-text.spec.ts` pins the live
// helper to the same pair.
const ACCENTED_CHARACTERS = 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ';
const PLAIN_CHARACTERS = 'aaaaaaceeeeiiiinooooouuuuyy';

const folded = (sqlExpression: string): string =>
  `translate(lower(${sqlExpression}), '${ACCENTED_CHARACTERS}', '${PLAIN_CHARACTERS}')`;

const FOLDED_SEARCH_VECTOR_COLUMN = `
      ALTER TABLE "magazine_article"
        ADD "search_vector" tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', ${folded(`coalesce("title", '')`)}), 'A') ||
          setweight(to_tsvector('english', ${folded(`coalesce("dek", '')`)}), 'B') ||
          setweight(to_tsvector('english', ${folded(`coalesce("standfirst", '')`)}), 'B') ||
          setweight(
            to_tsvector('english',
              ${folded(`magazine_article_tags_text("tags")`)}), 'B') ||
          setweight(to_tsvector('english', ${folded(`coalesce("body", '')`)}), 'D') ||
          setweight(
            to_tsvector('english',
              ${folded(`magazine_article_blocks_text("blocks")`)}), 'D')
        ) STORED
    `;

// Verbatim from `AddMagazineArticleSearchVector1794833600000`.
const PREVIOUS_SEARCH_VECTOR_COLUMN = `
      ALTER TABLE "magazine_article"
        ADD "search_vector" tsvector
        GENERATED ALWAYS AS (
          setweight(to_tsvector('english', coalesce("title", '')), 'A') ||
          setweight(to_tsvector('english', coalesce("dek", '')), 'B') ||
          setweight(to_tsvector('english', coalesce("standfirst", '')), 'B') ||
          setweight(
            to_tsvector('english',
              magazine_article_tags_text("tags")), 'B') ||
          setweight(to_tsvector('english', coalesce("body", '')), 'D') ||
          setweight(
            to_tsvector('english',
              magazine_article_blocks_text("blocks")), 'D')
        ) STORED
    `;

// Same definition as `AddMagazineArticleSearchVectorIndex1794833610000`,
// built inside this migration's transaction (see LOCKING above).
const SEARCH_VECTOR_INDEX =
  `CREATE INDEX "IDX_magazine_article_search_vector" ` +
  `ON "magazine_article" USING gin ("search_vector")`;

export class FoldMagazineArticleSearchVector1827500100000 implements MigrationInterface {
  name = 'FoldMagazineArticleSearchVector1827500100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_magazine_article_search_vector"`);
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "search_vector"`,
    );
    await queryRunner.query(FOLDED_SEARCH_VECTOR_COLUMN);
    await queryRunner.query(SEARCH_VECTOR_INDEX);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_magazine_article_search_vector"`);
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "search_vector"`,
    );
    await queryRunner.query(PREVIOUS_SEARCH_VECTOR_COLUMN);
    await queryRunner.query(SEARCH_VECTOR_INDEX);
  }
}
