import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `magazine_article.search_vector`: a STORED generated `tsvector` backing the
 * magazine's own free-text search (CON-12).
 *
 * Before this there was no `?q=` on `GET /magazine/articles` at all, and the
 * cross-entity global search reached the magazine through a leading-wildcard
 * `title ILIKE '%term%' OR dek ILIKE '%term%'` (`magazine.service.ts`
 * `searchByText`) — headline-only, unindexable, and blind to the piece's own
 * body. Live discovery was therefore the front page's newest nine pieces plus
 * a section grid; anything older was unreachable by search.
 *
 * WHY A GENERATED COLUMN, NOT AN EXPRESSION INDEX
 * An expression index (`CREATE INDEX ... USING gin (to_tsvector(...))`) would
 * work for the `@@` filter, but every query that also RANKS has to repeat the
 * whole expression in `ts_rank_cd(...)`, recomputing the vector per candidate
 * row at query time — including the jsonb walk below. Materialising it once
 * per write makes ranking a column read. Writes are rare here (an editorial
 * desk publishes a handful of pieces a week); reads are every search
 * keystroke, so the trade is firmly in the right direction.
 *
 * WHERE THE BODY TEXT COMES FROM
 * An article's body lives in two places: the legacy plain-text `body` column
 * and the block editor's `blocks` jsonb (see `MagazineArticle.blocks`). Older
 * pieces have only `body`, block-editor pieces have only `blocks`, so the
 * vector has to cover both or search silently loses half the archive.
 * `magazine_article_blocks_text()` below flattens the jsonb into plain text.
 *
 * A generation expression may only call IMMUTABLE functions, which rules out
 * the one-argument `to_tsvector(text)` / `jsonb_to_tsvector(jsonb)` forms
 * (STABLE — they read `default_text_search_config`). Every call here passes
 * the `'english'` regconfig literal explicitly, which is the IMMUTABLE form.
 *
 * `array_to_string` is the other trap, and a less obvious one. It is declared
 * STABLE because its `anyarray` signature has to allow for element types whose
 * output function reads a GUC — `timestamptz` against `TimeZone` is the case
 * that forces it. For a `text[]` the output function is `textout` and the
 * result really is immutable, but Postgres only reads the declaration and
 * rejects the whole generation expression. `magazine_article_tags_text()`
 * below pins the argument to `text[]` and re-declares the truth, which is the
 * standard way round it. Both helpers are IMMUTABLE for the same reason.
 *
 * WEIGHTS
 * `setweight` A/B/D, so `ts_rank_cd` puts a headline match above a body
 * mention rather than ordering hits by publish date:
 *   A — title
 *   B — dek, standfirst, tags
 *   D — legacy `body` text and the flattened block text
 * Author name is deliberately NOT in here: it lives in `magazine_author`, a
 * generated column cannot reach another table, and OR-ing a cross-table
 * predicate into the search would defeat the GIN index. Browsing by byline
 * already has its own surface (the author directory).
 *
 * LOCKING
 * Adding a STORED generated column rewrites the table under an ACCESS
 * EXCLUSIVE lock. `magazine_article` is an editorial table (hundreds of rows,
 * not millions), so the rewrite is short and a plain transactional ALTER is
 * correct. The GIN index that makes the column useful is built
 * `CONCURRENTLY` in its own follow-up migration
 * (`1794833610000-AddMagazineArticleSearchVectorIndex`), because
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block.
 */
export class AddMagazineArticleSearchVector1794833600000 implements MigrationInterface {
  name = 'AddMagazineArticleSearchVector1794833600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // Flattens the block-editor `blocks` jsonb into searchable plain text.
    //
    // Only the reader-visible prose keys are taken. `id` (a uuid) and `kind`
    // (the literal "paragraph"/"heading"/...) are skipped on purpose: indexing
    // them would make "paragraph" match every article in the magazine and add
    // a uuid token per block for nothing. `stats` blocks nest their prose one
    // level deeper (`items: [{ value, label }]`), so they get their own pass.
    //
    // `html` holds sanitized inline markup, so tags are stripped with a
    // regexp before the text is handed to `to_tsvector` — otherwise every
    // article indexes tokens like "em" and "strong".
    //
    // IMMUTABLE is truthful: the result depends only on the argument. It is
    // also what lets the generated column below call it at all.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION magazine_article_blocks_text(article_blocks jsonb)
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT regexp_replace(
                 coalesce(string_agg(fragment, ' '), ''),
                 '<[^>]*>', ' ', 'g')
          FROM (
            SELECT entry.value #>> '{}' AS fragment
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(article_blocks) = 'array'
                          THEN article_blocks ELSE '[]'::jsonb END
                   ) AS block(node),
                   jsonb_each(block.node) AS entry(key, value)
             WHERE jsonb_typeof(entry.value) = 'string'
               AND entry.key IN ('html', 'q', 'who', 'cite', 'alt',
                                 'caption', 'credit')
            UNION ALL
            SELECT item.value #>> '{}' AS fragment
              FROM jsonb_array_elements(
                     CASE WHEN jsonb_typeof(article_blocks) = 'array'
                          THEN article_blocks ELSE '[]'::jsonb END
                   ) AS block(node),
                   jsonb_array_elements(
                     CASE WHEN jsonb_typeof(block.node -> 'items') = 'array'
                          THEN block.node -> 'items' ELSE '[]'::jsonb END
                   ) AS stat(node),
                   jsonb_each(stat.node) AS item(key, value)
             WHERE jsonb_typeof(item.value) = 'string'
               AND item.key IN ('value', 'label')
          ) AS fragments
      $$
    `);

    // `array_to_string` is STABLE (see the note above), so the tag join is
    // pinned to `text[]` behind an IMMUTABLE wrapper. The `coalesce` lives
    // inside the helper so a NULL `tags` yields '' rather than a NULL, which
    // would propagate through `||` and null out the entire vector.
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION magazine_article_tags_text(article_tags text[])
      RETURNS text
      LANGUAGE sql
      IMMUTABLE
      PARALLEL SAFE
      AS $$
        SELECT coalesce(array_to_string(article_tags, ' '), '')
      $$
    `);

    await queryRunner.query(`
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
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "magazine_article" DROP COLUMN "search_vector"`,
    );
    // Dropped after the column: the generation expression depends on both.
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS magazine_article_blocks_text(jsonb)`,
    );
    await queryRunner.query(
      `DROP FUNCTION IF EXISTS magazine_article_tags_text(text[])`,
    );
  }
}
