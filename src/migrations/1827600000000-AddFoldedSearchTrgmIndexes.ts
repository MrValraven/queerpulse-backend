// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

// The expressions below are the frozen shape of the indexes, written out
// literally for the same reason `1795100000000-AddSearchTextIndexes` gives: a
// migration is history and must keep meaning what it meant on the day it ran.
// Each one is exactly what `foldedHaystack('', <columns>)` from
// `search/search-text.ts` generates for the column list named above it, in
// that order. Postgres matches an index built on the bare `"column"` form
// against a query that qualifies it as `"alias"."column"`, so one index serves
// every alias a caller uses.

// communities.service.ts COMMUNITY_SEARCH_HAYSTACK: ['name', 'tagline', 'purpose']
const COMMUNITIES_HAYSTACK =
  `translate(lower(coalesce("name", '') || ' ' || coalesce("tagline", '') || ' ' || ` +
  `coalesce("purpose", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// events.service.ts EVENT_DISCOVERY_SEARCH_HAYSTACK:
// ['title', 'venue', 'neighbourhood', 'description']
const EVENTS_DISCOVERY_HAYSTACK =
  `translate(lower(coalesce("title", '') || ' ' || coalesce("venue", '') || ' ' || ` +
  `coalesce("neighbourhood", '') || ' ' || coalesce("description", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// events.service.ts EVENT_SEARCH_HAYSTACK: ['title', 'venue', 'description']
const EVENTS_HAYSTACK =
  `translate(lower(coalesce("title", '') || ' ' || coalesce("venue", '') || ' ' || ` +
  `coalesce("description", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// jobs.service.ts searchByText: ['title', 'desc']
const JOBS_HAYSTACK =
  `translate(lower(coalesce("title", '') || ' ' || coalesce("desc", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// resources.service.ts searchByText:
// ['title', 'description', 'title_pt', 'description_pt']
const RESOURCES_HAYSTACK =
  `translate(lower(coalesce("title", '') || ' ' || coalesce("description", '') || ' ' || ` +
  `coalesce("title_pt", '') || ' ' || coalesce("description_pt", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// housing-directory.service.ts: ['title', 'blurb', 'city', 'area']
const HOUSING_LISTINGS_HAYSTACK =
  `translate(lower(coalesce("title", '') || ' ' || coalesce("blurb", '') || ' ' || ` +
  `coalesce("city", '') || ' ' || coalesce("area", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// directory.service.ts: ['name', 'blurb', 'hood']
const LISTINGS_DIRECTORY_HAYSTACK =
  `translate(lower(coalesce("name", '') || ' ' || coalesce("blurb", '') || ' ' || ` +
  `coalesce("hood", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// listings.service.ts findSimilar: ['name']
const LISTINGS_NAME_HAYSTACK =
  `translate(lower(coalesce("name", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// subprofile-public-read.service.ts PERSONA_SEARCH_HAYSTACK:
// ['display_name', 'tagline']
const SUBPROFILES_HAYSTACK =
  `translate(lower(coalesce("display_name", '') || ' ' || coalesce("tagline", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

// The name-and-handle haystack: ['first_name', 'last_name', 'slug'], shared by
// landing search, the community roster, admin trust network, admin media,
// verification, official-message recipients and the moderator picker.
const PROFILES_NAME_HAYSTACK =
  `translate(lower(coalesce("first_name", '') || ' ' || coalesce("last_name", '') || ' ' || ` +
  `coalesce("slug", '')), ` +
  `'áàâãäåçéèêëíìîïñóòôõöúùûüýÿ', 'aaaaaaceeeeiiiinooooouuuuyy')`;

/**
 * Index-backs the accent-folded substring searches ENG-503 moved off their
 * per-column trigram indexes.
 *
 * ENG-503 replaced every bare `col ILIKE '%term%'` with one folded haystack,
 * `foldedHaystack(alias, cols) LIKE foldedSearchTerm(p) ESCAPE '\'`, so
 * "Principe Real" finds "Príncipe Real" and "Joao" finds "João". The trigram
 * indexes from `1785700100000-AddSearchTrgmAndTagsIndexes`,
 * `1785800300000-AddGlobalSearchTrgmIndexes` and
 * `1785902200000-AddListingNameSearchIndex` sit on the bare columns (or on
 * `lower(col)`), and Postgres uses an expression index only for the exact
 * expression it was built on, so every one of those searches became a
 * sequential scan. Each index below is a trigram GIN over the exact folded
 * expression its callers now query, one per distinct column list.
 *
 * ## Why no partial predicate
 *
 * The callers filter on different combinations of status, visibility, removal
 * and archive flags. A partial index is only usable when every query states
 * its predicate, so these are full indexes.
 *
 * ## The old per-column indexes
 *
 * `1827700000000-DropSupersededSearchTrgmIndexes` drops them. The two
 * migrations ship together, both unapplied, and that one runs after this one
 * by timestamp order.
 *
 * `pg_trgm` is enabled by `1785700100000-AddSearchTrgmAndTagsIndexes` and was
 * re-asserted by `1795100000000`, so this migration relies on it as present.
 */
export class AddFoldedSearchTrgmIndexes1827600000000 implements MigrationInterface {
  name = 'AddFoldedSearchTrgmIndexes1827600000000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). No transactional DDL
  // lives in this file for that reason.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_search_folded_trgm" ` +
        `ON "communities" USING gin ((${COMMUNITIES_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_discovery_search_folded_trgm" ` +
        `ON "events" USING gin ((${EVENTS_DISCOVERY_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_search_folded_trgm" ` +
        `ON "events" USING gin ((${EVENTS_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_jobs_search_folded_trgm" ` +
        `ON "jobs" USING gin ((${JOBS_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_resources_search_folded_trgm" ` +
        `ON "resources" USING gin ((${RESOURCES_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_search_folded_trgm" ` +
        `ON "housing_listings" USING gin ((${HOUSING_LISTINGS_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_directory_search_folded_trgm" ` +
        `ON "listings" USING gin ((${LISTINGS_DIRECTORY_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_name_folded_trgm" ` +
        `ON "listings" USING gin ((${LISTINGS_NAME_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_search_folded_trgm" ` +
        `ON "subprofiles" USING gin ((${SUBPROFILES_HAYSTACK}) gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_name_search_folded_trgm" ` +
        `ON "profiles" USING gin ((${PROFILES_NAME_HAYSTACK}) gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_name_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_subprofiles_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_name_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_directory_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_housing_listings_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_resources_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_jobs_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_events_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_events_discovery_search_folded_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_communities_search_folded_trgm"`,
    );
  }
}
