// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Each old per-column trigram index this migration drops, with the exact DDL
 * its original migration built it with, so `down()` restores it byte for
 * byte. Listed in the order the originals created them; `up()` drops in this
 * order and `down()` rebuilds in reverse.
 */
const SUPERSEDED_INDEXES: ReadonlyArray<{ name: string; createSql: string }> = [
  // --- 1785700100000-AddSearchTrgmAndTagsIndexes ----------------------------
  {
    name: 'IDX_communities_name_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_communities_name_trgm" ` +
      `ON "communities" USING gin ("name" gin_trgm_ops)`,
  },
  {
    name: 'IDX_communities_tagline_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_communities_tagline_trgm" ` +
      `ON "communities" USING gin ("tagline" gin_trgm_ops)`,
  },
  {
    name: 'IDX_communities_purpose_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_communities_purpose_trgm" ` +
      `ON "communities" USING gin ("purpose" gin_trgm_ops)`,
  },
  {
    name: 'IDX_events_title_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_events_title_trgm" ` +
      `ON "events" USING gin ("title" gin_trgm_ops)`,
  },
  {
    name: 'IDX_events_venue_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_events_venue_trgm" ` +
      `ON "events" USING gin ("venue" gin_trgm_ops)`,
  },
  {
    name: 'IDX_events_description_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_events_description_trgm" ` +
      `ON "events" USING gin ("description" gin_trgm_ops)`,
  },
  {
    name: 'IDX_listings_name_lower_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_listings_name_lower_trgm" ` +
      `ON "listings" USING gin (lower("name") gin_trgm_ops)`,
  },
  {
    name: 'IDX_listings_blurb_lower_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_listings_blurb_lower_trgm" ` +
      `ON "listings" USING gin (lower("blurb") gin_trgm_ops)`,
  },
  {
    name: 'IDX_listings_hood_lower_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_listings_hood_lower_trgm" ` +
      `ON "listings" USING gin (lower("hood") gin_trgm_ops)`,
  },

  // --- 1785800300000-AddGlobalSearchTrgmIndexes -----------------------------
  {
    name: 'IDX_jobs_title_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_jobs_title_trgm" ` +
      `ON "jobs" USING gin ("title" gin_trgm_ops)`,
  },
  {
    name: 'IDX_jobs_desc_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_jobs_desc_trgm" ` +
      `ON "jobs" USING gin ("desc" gin_trgm_ops)`,
  },
  {
    name: 'IDX_resources_title_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_resources_title_trgm" ` +
      `ON "resources" USING gin ("title" gin_trgm_ops)`,
  },
  {
    name: 'IDX_resources_description_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_resources_description_trgm" ` +
      `ON "resources" USING gin ("description" gin_trgm_ops)`,
  },
  {
    name: 'IDX_housing_listings_title_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_title_trgm" ` +
      `ON "housing_listings" USING gin ("title" gin_trgm_ops)`,
  },
  {
    name: 'IDX_housing_listings_blurb_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_blurb_trgm" ` +
      `ON "housing_listings" USING gin ("blurb" gin_trgm_ops)`,
  },
  {
    name: 'IDX_housing_listings_city_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_city_trgm" ` +
      `ON "housing_listings" USING gin ("city" gin_trgm_ops)`,
  },
  {
    name: 'IDX_housing_listings_area_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_area_trgm" ` +
      `ON "housing_listings" USING gin ("area" gin_trgm_ops)`,
  },
  {
    name: 'IDX_subprofiles_display_name_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_display_name_trgm" ` +
      `ON "subprofiles" USING gin ("display_name" gin_trgm_ops)`,
  },
  {
    name: 'IDX_subprofiles_tagline_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_tagline_trgm" ` +
      `ON "subprofiles" USING gin ("tagline" gin_trgm_ops)`,
  },

  // --- 1785902200000-AddListingNameSearchIndex ------------------------------
  {
    name: 'IDX_listings_name_trgm',
    createSql:
      `CREATE INDEX CONCURRENTLY "IDX_listings_name_trgm" ` +
      `ON "listings" USING gin ("name" gin_trgm_ops)`,
  },
];

/**
 * Drops the 20 per-column trigram indexes that
 * `1827600000000-AddFoldedSearchTrgmIndexes` superseded.
 *
 * ENG-503 moved every substring search on these tables onto one accent-folded
 * haystack (`foldedHaystack(alias, cols) LIKE foldedSearchTerm(p)`), and
 * `1827600000000` built a trigram GIN over each exact folded expression.
 * Postgres uses an expression index only for the expression it was built on,
 * so the old indexes on the bare column (or on `lower(col)`) serve no query
 * any more. They still cost a GIN update on every write to these tables and
 * the disk they occupy, so they go.
 *
 * ## Proof of no remaining readers
 *
 * Before this was written, all of backend `src` outside `migrations/` was
 * searched for any predicate that could use one of these indexes: `ILIKE`,
 * `LIKE`, `~`/`~*`, `similarity(`, `word_similarity`, the `%`/`<%`/`<->`
 * trigram operators, `lower(<col>)`, TypeORM `ILike(`/`Like(`/`Raw(` find
 * operators, equality (which `gin_trgm_ops` can also serve) and `where:`
 * find options on these columns, including the global search fan-out in
 * `search/search.service.ts`. Every search on these tables goes through the
 * folded haystack constants in `search/search-text.ts`. The only
 * `similarity()` ranking (`searchRankExpression`) runs on forum threads and
 * profiles. The remaining `lower()` equality filters on `housing_listings`
 * city/area and `events` neighbourhood use their own btree expression indexes.
 *
 * ## Kept
 *
 * Every `IDX_profiles_*` trigram index from `1785700100000` stays: other
 * callers still match on bare profile columns. `IDX_forum_thread_title_trgm`,
 * `IDX_magazine_article_*_trgm` and `IDX_workshops_*_trgm` were outside this
 * cleanup and stay as they are.
 *
 * ## Running it, and a partial failure
 *
 * `DROP INDEX CONCURRENTLY` cannot run inside a transaction block, so this
 * migration opts out (`transaction = false`) and each drop commits on its own.
 * If the run dies partway, the indexes already dropped stay dropped and the
 * ledger records nothing, so the retry runs `up()` from the top. `IF EXISTS`
 * lets that retry pass over them.
 *
 * CLAUDE.md's migration notes forbid guarding DDL with `IF [NOT] EXISTS` as
 * the fix for an "already exists" failure, because the guard hides schema
 * drift. The `IF EXISTS` on these drops is a deliberate exception, so leave
 * it in place: it exists only for the retry after a partial `CONCURRENTLY`
 * failure described above, where the ledger is correct and the missing
 * indexes are this migration's own earlier work. The drift it could hide is
 * an index already gone, which is the state `up()` produces anyway. Precedent:
 * `1787700100000-NarrowSubprofileHandleUniqueIndexToPublished` drops with the
 * same guard. `down()` keeps plain `CREATE INDEX CONCURRENTLY`, as the rule
 * asks.
 *
 * An interrupted concurrent drop can also leave its index marked invalid; the
 * deploy preflight (`scripts/migration-preflight.mjs`) sweeps those, and the
 * retry drops it either way. If `down()` dies partway, drop the indexes it
 * already rebuilt (the preflight clears any invalid stub) before running it
 * again. `pg_trgm` stays
 * enabled throughout, so `down()` can rely on it. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 */
export class DropSupersededSearchTrgmIndexes1827700000000 implements MigrationInterface {
  name = 'DropSupersededSearchTrgmIndexes1827700000000';

  // Runs outside a transaction for `DROP/CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). No transactional DDL
  // lives in this file for that reason.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    for (const index of SUPERSEDED_INDEXES) {
      await queryRunner.query(
        `DROP INDEX CONCURRENTLY IF EXISTS "${index.name}"`,
      );
    }
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const index of [...SUPERSEDED_INDEXES].reverse()) {
      await queryRunner.query(index.createSql);
    }
  }
}
