import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Closes the P1 feed/forum indexing gap: `FeedService`'s cross-source
 * aggregation (`community_post`/`forum_thread`/`gathering` branches) and
 * `ForumThreadsService`'s default (no-`category`) thread listing all paginate
 * newest-first via `cursorPaginate`, which — as of
 * `1785001400000-NarrowCursorCreatedAtPrecision.ts` — orders/filters these
 * three tables' `created_at` directly (no more `date_trunc(...)` wrapper), so
 * a plain/partial btree index can now actually serve the query instead of a
 * full-table `Seq Scan` + in-memory `Sort`.
 *
 * ⚠️ `forum_thread` already HAS the needed index — nothing to create there.
 * `1782800210000-AddForum.ts:44-46` created
 * `IDX_forum_thread_created_at_id ON "forum_thread" ("created_at" DESC, "id"
 * DESC)` back when the table was new, with exactly this query in mind (its
 * own comment cites `cursorPaginate`). It has been dead weight ever since:
 * `cursorPaginate`'s `date_trunc('milliseconds', "t"."created_at")` wrapper
 * doesn't match the raw-column expression the index is built on, so Postgres
 * could never use it — the P1 finding's "no WHERE at all" full scan on
 * `forum_thread` was happening *despite* a correctly-shaped index existing,
 * purely because of the `date_trunc` mismatch. `forum-threads.service.ts` and
 * `feed.service.ts` now both call `cursorPaginate(..., true)` for
 * `ForumThread`, which drops the wrapper and lets this existing index serve
 * the query again — no new DDL required for this table, and adding a
 * same-name index here would fail with "relation already exists" if ever run
 * on a schema that already has it.
 *
 * The two indexes below ARE new — `community_posts` and `events` have never
 * had a `created_at`-covering index (confirmed against
 * `1782693200000-AddCommunities.ts`/`1782691900000-AddEvents.ts`, which only
 * index `community_id`/`author_id` and `host_id` respectively). Both use
 * `CONCURRENTLY`, since both tables already carry production traffic — a
 * plain `CREATE INDEX` would hold a lock that blocks writes for the build's
 * duration. `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual), and this project's migration runner
 * wraps pending migrations in one shared transaction by default
 * (`migrationsTransactionMode: 'all'`, undisturbed in `src/data-source.ts` —
 * see `1782800710000-AddDeactivatedStatus.ts` for the same landmine
 * documented once already). Run this migration on its own:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * - `IDX_community_posts_created_at_id` — `FeedService`'s `community_post`
 *   branch (`feed.service.ts`) always filters `deletedAt IS NULL` as a
 *   top-level `AND` (redacting tombstoned posts from the aggregated feed
 *   entirely, unlike a single community's own feed, which renders them as
 *   "[deleted]" — see the comment at `feed.service.ts`'s `community_post`
 *   case), so a partial index on that predicate is valid and smaller than an
 *   unconditional one. NOT the same index as
 *   `IDX_community_posts_feed_order` in
 *   `1785001600000-AddCommunityPostsFeedOrderIndex.ts` — this one has no
 *   `community_id` leading column because the feed query has no per-community
 *   filter; `community_id` as a leading column here would be unusable for a
 *   cross-community scan (see "Multicolumn Indexes", PostgreSQL manual on
 *   leading-column requirements).
 * - `IDX_events_feed_created_at_id` — a partial index matching
 *   `FeedService`'s `gathering` branch predicate exactly
 *   (`status = 'published' AND visibility IN ('public','members')`), so the
 *   index scan serves the filter *and* the sort with no separate `Sort` node.
 */
export class AddFeedCursorIndexes1785001500000 implements MigrationInterface {
  name = 'AddFeedCursorIndexes1785001500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_posts_created_at_id" ` +
        `ON "community_posts" ("created_at" DESC, "id" DESC) ` +
        `WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_events_feed_created_at_id" ` +
        `ON "events" ("created_at" DESC, "id" DESC) ` +
        `WHERE "status" = 'published' AND "visibility" IN ('public', 'members')`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_events_feed_created_at_id"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_posts_created_at_id"`,
    );
  }
}
