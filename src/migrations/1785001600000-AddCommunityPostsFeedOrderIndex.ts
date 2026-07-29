import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * P4 fix: `CommunityPostsService.listPosts` (`community-posts.service.ts`)
 * runs `.where('p.community_id = :communityId').orderBy('p.pinned', 'DESC')
 * .addOrderBy('p.created_at', 'DESC')` on raw columns — a different query
 * from the P1 cross-community feed fixed in
 * `1785001500000-AddFeedCursorIndexes.ts` (this one filters to a single
 * community and doesn't go through `cursorPaginate` at all; it uses
 * `common/pagination.ts`'s offset-based `paginate`). Today this only has
 * `IDX_community_posts_community_id` to serve the filter — the `(pinned,
 * created_at)` ordering is a separate in-memory `Sort` node on every page.
 *
 * ⚠️ Deviates from a partial `WHERE deleted_at IS NULL` predicate: read
 * `community-posts.service.ts:78-102` directly before assuming that's
 * correct. Unlike the aggregated cross-community feed (which redacts
 * tombstoned posts entirely — see the P1 migration's comment), a single
 * community's own `listPosts` does NOT filter `deletedAt` — soft-deleted
 * posts stay in the page and render as "[deleted]" (mirrors the comment at
 * `feed.service.ts`'s `community_post` case, which explicitly contrasts the
 * two). A `WHERE deleted_at IS NULL` partial index would never be chosen by
 * the planner for this query, since Postgres only uses a partial index when
 * the query's `WHERE` clause provably implies the index's predicate
 * ("Partial Indexes", PostgreSQL manual) — this query has no such predicate.
 * Building it anyway would be pure write-amplification with zero read
 * benefit (see database-and-indexing.md Fix #3, "don't over-index"). This
 * index is therefore unconditional (no `WHERE`), covering the query as it
 * actually reads today. Confirm with `EXPLAIN (ANALYZE, BUFFERS)` once a
 * dev DB is available.
 *
 * `CONCURRENTLY` because `community_posts` already carries production
 * traffic; cannot run inside a transaction block, so this migration must run
 * on its own: `pnpm run typeorm migration:run -- --transaction none` (see
 * `1785001500000-AddFeedCursorIndexes.ts` for the full landmine writeup).
 */
export class AddCommunityPostsFeedOrderIndex1785001600000
  implements MigrationInterface
{
  name = 'AddCommunityPostsFeedOrderIndex1785001600000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_posts_feed_order" ` +
        `ON "community_posts" ("community_id", "pinned", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_posts_feed_order"`,
    );
  }
}
