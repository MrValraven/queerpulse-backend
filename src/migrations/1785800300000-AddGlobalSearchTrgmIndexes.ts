import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Extends the global-search index coverage to the six entity types added to
 * `SearchService.search` (magazine articles, jobs, housing listings,
 * resources, workshops, standalone subprofiles). Each new `searchByText`
 * branch runs a leading-wildcard `ILIKE '%term%'` over unindexed text columns
 * — the exact index-cannot-help pattern the first search-index migration
 * (`1785700100000-AddSearchTrgmAndTagsIndexes.ts`) closed for the original
 * five request-paths. This migration follows that precedent verbatim: one GIN
 * trigram index per scanned text column (the planner combines OR'd branches
 * with a `BitmapOr`, so per-column is correct, not one composite), built
 * `CONCURRENTLY` because every table already carries traffic.
 *
 * New scanned columns (each backing a `col ILIKE :pattern` branch):
 *   - magazine_article  — `title`, `dek`        (`magazine.service.ts` searchByText)
 *   - jobs              — `title`, `desc`       (`jobs.service.ts` searchByText)
 *   - resources         — `title`, `description`(`resources.service.ts` searchByText)
 *   - workshops         — `title`, `blurb`      (`workshops.service.ts` searchByText)
 *   - housing_listings  — `title`, `blurb`, `city`, `area`
 *                                               (`housing-directory.service.ts` searchByText)
 *   - subprofiles       — `display_name`, `tagline`
 *                                               (`subprofiles.service.ts` searchByText,
 *                                                same columns `directory` already ILIKEs)
 *
 * `pg_trgm` is enabled by the earlier migration; `CREATE EXTENSION IF NOT
 * EXISTS` is repeated here only as the standard idempotent guard (it is not a
 * ledger'd object this migration re-creates), so the migration is safe to run
 * even if the earlier one somehow has not. `CREATE INDEX CONCURRENTLY` cannot
 * run inside a transaction block, and `CREATE EXTENSION` needs none, so this
 * migration opts out of the wrapping transaction (`transaction = false`,
 * honored because `data-source.ts` sets `migrationsTransactionMode: 'each'`).
 * Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` drops every index it created; `pg_trgm` is deliberately left
 * enabled (other trigram indexes depend on it — mirrors the earlier
 * migration's `down`).
 */
export class AddGlobalSearchTrgmIndexes1785800300000 implements MigrationInterface {
  name = 'AddGlobalSearchTrgmIndexes1785800300000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). See the earlier
  // search-index migration for the full rationale on why `IF NOT EXISTS`
  // guards are forbidden on the indexes themselves (they hide drift).
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // --- magazine_article (magazine.service.ts searchByText) -----------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_magazine_article_title_trgm" ` +
        `ON "magazine_article" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_magazine_article_dek_trgm" ` +
        `ON "magazine_article" USING gin ("dek" gin_trgm_ops)`,
    );

    // --- jobs (jobs.service.ts searchByText) ---------------------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_jobs_title_trgm" ` +
        `ON "jobs" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_jobs_desc_trgm" ` +
        `ON "jobs" USING gin ("desc" gin_trgm_ops)`,
    );

    // --- resources (resources.service.ts searchByText) -----------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_resources_title_trgm" ` +
        `ON "resources" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_resources_description_trgm" ` +
        `ON "resources" USING gin ("description" gin_trgm_ops)`,
    );

    // --- workshops (workshops.service.ts searchByText) -----------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_workshops_title_trgm" ` +
        `ON "workshops" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_workshops_blurb_trgm" ` +
        `ON "workshops" USING gin ("blurb" gin_trgm_ops)`,
    );

    // --- housing_listings (housing-directory.service.ts searchByText) --------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_title_trgm" ` +
        `ON "housing_listings" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_blurb_trgm" ` +
        `ON "housing_listings" USING gin ("blurb" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_city_trgm" ` +
        `ON "housing_listings" USING gin ("city" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_housing_listings_area_trgm" ` +
        `ON "housing_listings" USING gin ("area" gin_trgm_ops)`,
    );

    // --- subprofiles (subprofiles.service.ts searchByText + directory) -------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_display_name_trgm" ` +
        `ON "subprofiles" USING gin ("display_name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_subprofiles_tagline_trgm" ` +
        `ON "subprofiles" USING gin ("tagline" gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_subprofiles_tagline_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_subprofiles_display_name_trgm"`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_housing_listings_area_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_housing_listings_city_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_housing_listings_blurb_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_housing_listings_title_trgm"`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_workshops_blurb_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_workshops_title_trgm"`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_resources_description_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_resources_title_trgm"`,
    );

    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_jobs_desc_trgm"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_jobs_title_trgm"`);

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_magazine_article_dek_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_magazine_article_title_trgm"`,
    );

    // `pg_trgm` itself is intentionally NOT dropped — other trigram indexes
    // depend on it (mirrors the earlier search-index migration's `down`).
  }
}
