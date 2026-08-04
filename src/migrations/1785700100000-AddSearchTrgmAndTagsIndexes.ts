import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the Performance & Cost audit's global-search finding
 * (AUDIT-2026-07-30.md §I): `SearchService.search` (`search/search.service.ts`)
 * fans a query out to five request-paths, and every one of them runs a
 * leading-wildcard `ILIKE '%term%'` (or, for `listings`, `LOWER(col) LIKE
 * '%term%'`) with no index able to serve it — a plain b-tree cannot help a
 * pattern that doesn't start from a known prefix (see
 * `database-and-indexing.md`'s "A WHERE clause an index structurally cannot
 * help with"). Unlike the messaging DM-body search
 * (`messages.service.ts:275`, deliberately left unindexed because it's
 * pre-scoped to one member's own conversations), these five scan
 * request-wide, unscoped tables — worst of all `profiles`, which grows 1:1
 * with the member base:
 *
 *   - `profiles.searchMembers`      (`profiles.service.ts:734-737`) — OR'd
 *     ILIKE over `first_name`, `last_name`, `slug`, `tagline`
 *   - `communities.searchByText`    (`communities.service.ts:335-338`) — OR'd
 *     ILIKE over `name`, `tagline`, `purpose`
 *   - `forumThreads.searchByText`   (`forum-threads.service.ts:100`) — ILIKE
 *     over `title`
 *   - `events.searchByText`         (`events.service.ts:326-329`) — OR'd
 *     ILIKE over `title`, `venue`, `description`
 *   - `directory.listDirectory`     (`directory.service.ts:149-156`) — OR'd
 *     `LOWER(col) LIKE` over `name`, `blurb`, `hood` (term is already
 *     lowercased by the caller, so this is case-insensitive matching spelled
 *     with `LOWER(...) LIKE` instead of `ILIKE` — the expression indexes
 *     below match that exact shape rather than rewriting the query)
 *
 * `profiles.loadRelated` (`profiles.service.ts:302`) and `searchMembers`
 * (`profiles.service.ts:742`) also both filter `profiles.tags && :tags`
 * (array overlap) with no index — same fix category (GIN), different
 * operator class.
 *
 * Fix: enable `pg_trgm` and add one GIN trigram index per scanned text
 * column, so each OR'd ILIKE branch can be served by its own index scan (the
 * planner combines them with a `BitmapOr` — one composite index would only
 * help a single column, per "Multicolumn Indexes", PostgreSQL manual, so
 * per-column is correct here, not an oversight). Trigram indexes only help
 * patterns with 3+ literal characters; a 1-2 character search term still
 * falls back to a scan for that column — strictly a subset of today's
 * always-scan behavior, never a regression. `profiles.tags` gets a plain
 * (non-trigram) GIN index instead, matching the array-overlap precedent
 * already in the schema (`1782800510000-AddMagazine.ts:92`'s
 * `IDX_magazine_article_tags ... USING GIN ("tags")`, itself undecorated on
 * its entity — followed here for the same reason: TypeORM's `@Index`
 * decorator has no clean way to express an operator class or an expression
 * index, so these are migration-only, with a code comment at each scanned
 * column instead of a decorator).
 *
 * All five tables already carry production traffic (`profiles`, `communities`,
 * `events`, and `listings` all have prior `CONCURRENTLY` migrations against
 * them — e.g. `1785001700000-AddListingsStatusIndex.ts`,
 * `1785001500000-AddFeedCursorIndexes.ts` — and `forum_thread` per
 * `1785001900000-AddForumPostParent.ts`), so every index below is built
 * `CREATE INDEX CONCURRENTLY`, never a plain blocking `CREATE INDEX`.
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual), and `CREATE EXTENSION` does not need
 * one either, so this migration opts out entirely — see `transaction = false`
 * below (honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`). Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * `down()` drops every index this migration created but deliberately leaves
 * `pg_trgm` enabled — other trigram indexes may come to depend on the
 * extension later, and `DROP EXTENSION` would take those out too.
 */
export class AddSearchTrgmAndTagsIndexes1785700100000 implements MigrationInterface {
  name = 'AddSearchTrgmAndTagsIndexes1785700100000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // guards on the indexes (forbidden here — hides drift; see CLAUDE.md).
  // `CREATE EXTENSION IF NOT EXISTS` is the one exception: it's the standard,
  // idempotent Postgres idiom for enabling an extension (not a ledger'd
  // object this migration itself would be re-creating), and the task brief
  // for this fix explicitly calls for it.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pg_trgm"`);

    // --- profiles (member search: profiles.service.ts:734-737, 742) ---------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_first_name_trgm" ` +
        `ON "profiles" USING gin ("first_name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_last_name_trgm" ` +
        `ON "profiles" USING gin ("last_name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_slug_trgm" ` +
        `ON "profiles" USING gin ("slug" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_tagline_trgm" ` +
        `ON "profiles" USING gin ("tagline" gin_trgm_ops)`,
    );
    // Array-overlap (`&&`), not trigram — same fix category, different
    // operator class. Backs `profiles.tags && :tags` at
    // `profiles.service.ts:302` (loadRelated) and `:742` (searchMembers).
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_profiles_tags" ` +
        `ON "profiles" USING gin ("tags")`,
    );

    // --- communities (communities.service.ts:335-338) -----------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_name_trgm" ` +
        `ON "communities" USING gin ("name" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_tagline_trgm" ` +
        `ON "communities" USING gin ("tagline" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_communities_purpose_trgm" ` +
        `ON "communities" USING gin ("purpose" gin_trgm_ops)`,
    );

    // --- forum_thread (forum-threads.service.ts:100) -------------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_thread_title_trgm" ` +
        `ON "forum_thread" USING gin ("title" gin_trgm_ops)`,
    );

    // --- events (events.service.ts:326-329) ----------------------------------
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_title_trgm" ` +
        `ON "events" USING gin ("title" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_venue_trgm" ` +
        `ON "events" USING gin ("venue" gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_description_trgm" ` +
        `ON "events" USING gin ("description" gin_trgm_ops)`,
    );

    // --- listings (directory.service.ts:149-156) -----------------------------
    // Expression indexes on `lower(col)`, matching the query's
    // `LOWER(listing.col) LIKE :term` shape exactly (the query already
    // lowercases the search term before binding it) — a plain
    // `gin_trgm_ops` index on the raw column would NOT be usable here,
    // since the predicate filters on the `lower(...)` expression, not the
    // column itself.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_name_lower_trgm" ` +
        `ON "listings" USING gin (lower("name") gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_blurb_lower_trgm" ` +
        `ON "listings" USING gin (lower("blurb") gin_trgm_ops)`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_listings_hood_lower_trgm" ` +
        `ON "listings" USING gin (lower("hood") gin_trgm_ops)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_hood_lower_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_blurb_lower_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_listings_name_lower_trgm"`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_events_description_trgm"`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_events_venue_trgm"`);
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_events_title_trgm"`);

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_thread_title_trgm"`,
    );

    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_communities_purpose_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_communities_tagline_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_communities_name_trgm"`,
    );

    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_profiles_tags"`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_tagline_trgm"`,
    );
    await queryRunner.query(`DROP INDEX CONCURRENTLY "IDX_profiles_slug_trgm"`);
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_last_name_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_profiles_first_name_trgm"`,
    );

    // `pg_trgm` itself is intentionally NOT dropped here — see the class
    // comment above. Leave it enabled for whatever else may come to depend
    // on it.
  }
}
