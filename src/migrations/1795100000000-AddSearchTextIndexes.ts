import { MigrationInterface, QueryRunner } from 'typeorm';

// The expressions below are the frozen shape of the indexes. They are written
// out literally rather than imported from `search/search-text.ts` because a
// migration is history: it must keep meaning what it meant on the day it ran,
// however the application code moves afterwards. `search-text.spec.ts` asserts
// the helper still generates exactly these strings, so the two cannot drift
// without a test failing.
const PROFILES_VECTOR =
  `setweight(to_tsvector('simple', translate(lower(coalesce("first_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("last_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("slug", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("tagline", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'B') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("bio", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'C') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("bio_pt", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'C')`;

const PROFILES_HAYSTACK =
  `translate(lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || ` +
  `coalesce("slug", '') || ' ' || coalesce("tagline", '') || ' ' || ` +
  `coalesce("bio", '') || ' ' || coalesce("bio_pt", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

const FORUM_THREAD_VECTOR =
  `setweight(to_tsvector('simple', translate(lower(coalesce("title", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A')`;

const FORUM_THREAD_HAYSTACK =
  `translate(lower(coalesce("title", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

const FORUM_POST_VECTOR =
  `setweight(to_tsvector('simple', translate(lower(coalesce("body", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'B')`;

/**
 * Ranked, accent-insensitive global search (SOC-08).
 *
 * Before this, every `searchByText` ran a bare `ILIKE '%term%'` ordered by
 * recency. No relevance, no accent folding: on a platform whose audience
 * writes Portuguese, "Sao" never found "São". Forum search read thread titles
 * only, so the reply that actually answered the question was unreachable, and
 * member search skipped the bio entirely.
 *
 * ## Why expression indexes and not a generated `tsvector` column
 *
 * Both were on the table. Expression indexes won on four counts:
 *
 *  1. `unaccent()` is only STABLE, so it can back neither an expression index
 *     nor a `GENERATED ALWAYS AS … STORED` column without a hand-written
 *     IMMUTABLE wrapper function. The repo already folds accents with
 *     `translate(lower(x), 'áàâã…', 'aaaa…')` (`connections/connection-search.ts`),
 *     which IS immutable and needs no extension at all. Reusing it removes the
 *     wrapper, the `CREATE EXTENSION unaccent`, and the role privilege that
 *     would have required.
 *  2. A generated column means `ALTER TABLE … ADD COLUMN … GENERATED ALWAYS AS
 *     … STORED`, which rewrites the whole table under an ACCESS EXCLUSIVE lock
 *     — on `profiles`, the one table that grows 1:1 with membership. Every
 *     index here is built `CONCURRENTLY` and takes no such lock.
 *  3. This backend has NO global response serializer (see CLAUDE.md): responses
 *     are hand-mapped, but a new entity column is still selected by default by
 *     every `getMany()` in three services, and a folded copy of a member's bio
 *     is not something to leave one forgotten `find()` away from a response
 *     body. An expression index adds no column and no entity change.
 *  4. Index and predicate cannot drift: `search/search-text.ts` generates the
 *     exact expression strings below for the query side too, and its spec pins
 *     them against this file.
 *
 * ## Why two kinds of index per table
 *
 * The `tsvector` GIN backs the `@@ websearch_to_tsquery(...)` branch (whole
 * tokens, ranked). The trigram GIN backs the folded `LIKE '%…%'` branch that
 * every caller ORs alongside it, because full text matches whole tokens: drop
 * the substring branch and searching "trans" stops finding "transfeminine",
 * a straight regression on today's behaviour.
 *
 * `forum_post` deliberately gets NO trigram index. A GIN trigram index over
 * long post bodies is the most expensive index here by a wide margin, and post
 * bodies were not searchable at all before this migration — there is no
 * behaviour to regress, so post search is full-text only.
 *
 * `pg_trgm` is already enabled by `1785700100000-AddSearchTrgmAndTagsIndexes`;
 * the `CREATE EXTENSION IF NOT EXISTS` below keeps this migration standalone,
 * matching what `1785800300000-AddGlobalSearchTrgmIndexes` does.
 */
export class AddSearchTextIndexes1795100000000 implements MigrationInterface {
  name = 'AddSearchTextIndexes1795100000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). This migration
  // contains NO transactional DDL for exactly that reason: mixing the two
  // would need a second, transactional migration.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // --- profiles (profiles.service.ts searchMembers) -----------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_search_tsv" ` +
        `ON "profiles" USING gin ((${PROFILES_VECTOR}))`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_search_folded_trgm" ` +
        `ON "profiles" USING gin ((${PROFILES_HAYSTACK}) gin_trgm_ops)`,
    );

    // --- forum_thread (forum-threads.service.ts searchByText) ---------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_thread_search_tsv" ` +
        `ON "forum_thread" USING gin ((${FORUM_THREAD_VECTOR}))`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_thread_search_folded_trgm" ` +
        `ON "forum_thread" USING gin ((${FORUM_THREAD_HAYSTACK}) gin_trgm_ops)`,
    );

    // --- forum_post (forum-posts.service.ts searchByText, new in SOC-08) ----
    // Partial on `deleted_at IS NULL`: a tombstoned post keeps its `body` so a
    // moderator can restore it, and search must never surface that text. The
    // search predicate carries the same `deleted_at IS NULL`, so Postgres can
    // use the partial index, and the index skips every tombstone.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_search_tsv" ` +
        `ON "forum_post" USING gin ((${FORUM_POST_VECTOR})) ` +
        `WHERE "deleted_at" IS NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_post_search_tsv"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_thread_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_thread_search_tsv"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_search_tsv"`,
    );
    // `pg_trgm` is deliberately NOT dropped — earlier migrations' trigram
    // indexes depend on it.
  }
}
