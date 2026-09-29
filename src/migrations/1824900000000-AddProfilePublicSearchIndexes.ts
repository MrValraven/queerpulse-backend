import { MigrationInterface, QueryRunner } from 'typeorm';

// The expressions below are the frozen shape of the indexes, written out
// literally for the same reason `1795100000000-AddSearchTextIndexes` gives: a
// migration is history and must keep meaning what it meant on the day it ran.
// `search-text.spec.ts` asserts that `weightedSearchVector('',
// PROFILE_PUBLIC_SEARCH_FIELDS)` and `foldedHaystack('',
// PROFILE_PUBLIC_SEARCH_COLUMNS)` still generate exactly these strings.
const PROFILES_PUBLIC_VECTOR =
  `setweight(to_tsvector('simple', translate(lower(coalesce("first_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("last_name", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("slug", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'A') || ` +
  `setweight(to_tsvector('simple', translate(lower(coalesce("tagline", '')), 'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')), 'B')`;

const PROFILES_PUBLIC_HAYSTACK =
  `translate(lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || ` +
  `coalesce("slug", '') || ' ' || coalesce("tagline", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// The partial-index predicate. The query's second branch carries
// `NOT "p"."visibility" = 'open'`, which the planner normalises to
// `"visibility" <> 'open'` (negate_clause swaps `=` for its negator), so this
// predicate is proven from the branch's own clauses and the index qualifies.
const NOT_OPEN_PREDICATE = `"visibility" <> 'open'`;

/**
 * Index-backs the hidden-bio branch of member search (ENG-438 follow-up).
 *
 * `memberSearchTextMatch` (`profiles/member-directory.query.ts`) is an OR of
 * two exclusive branches:
 *
 *  1. `visibility = 'open'` AND a match over every profile field, bios
 *     included. Those are the exact expressions `1795100000000` indexed
 *     (`IDX_profiles_search_tsv`, `IDX_profiles_search_folded_trgm`).
 *  2. `NOT visibility = 'open'` AND a match over the same fields minus both
 *     bios. Until now no index existed on those expressions.
 *
 * Postgres can answer an OR with a BitmapOr only when EVERY arm has an index
 * path. With branch 2 unindexed the whole predicate fell back to a sequential
 * scan of `profiles` on every directory search. The two indexes below give
 * branch 2 the same pair the open branch has: a `tsvector` GIN for the
 * `@@ websearch_to_tsquery(...)` half and a trigram GIN for the folded
 * `LIKE '%…%'` half.
 *
 * ## Why partial
 *
 * Branch 2 only ever reads `network`/`private` rows, and it states that in its
 * own WHERE (`NOT "p"."visibility" = 'open'`, a literal, so it is planned as a
 * constant). The planner proves `"visibility" <> 'open'` from that clause, so
 * a partial index is usable here and skips every `open` row, the tier most
 * members sit in (it is the column default). Smaller index, cheaper writes.
 * `member-directory.query.spec.ts` pins the branch's literal gate so a
 * rewrite that would stop the proof fails a test.
 *
 * ## The profession and discipline arms
 *
 * `applyDirectoryFilters` ORs two more arms into the same search group when
 * the frontend resolved the search words to catalog ids
 * (`p.profession && ...`, `p.discipline && ...`). Their GIN indexes live in
 * `1824910000000-AddProfileProfessionDisciplineGinIndexes`.
 *
 * `pg_trgm` is enabled by `1785700100000-AddSearchTrgmAndTagsIndexes` and was
 * re-asserted by `1795100000000`, so this migration relies on it as present.
 */
export class AddProfilePublicSearchIndexes1824900000000 implements MigrationInterface {
  name = 'AddProfilePublicSearchIndexes1824900000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). No transactional DDL
  // lives in this file for that reason.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_public_search_tsv" ` +
        `ON "profiles" USING gin ((${PROFILES_PUBLIC_VECTOR})) ` +
        `WHERE ${NOT_OPEN_PREDICATE}`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_public_search_folded_trgm" ` +
        `ON "profiles" USING gin ((${PROFILES_PUBLIC_HAYSTACK}) gin_trgm_ops) ` +
        `WHERE ${NOT_OPEN_PREDICATE}`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_public_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_public_search_tsv"`,
    );
  }
}
