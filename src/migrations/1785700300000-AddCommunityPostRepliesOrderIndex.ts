import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Performance-track fix (community-post replies unbounded hot path):
 * `CommunityPostsService.topRepliesByPost`/`replyCountByPost`/`listReplies`
 * (`community-posts.service.ts`) all filter `community_post_replies` on
 * `post_id` and order/window on `created_at` (+ `id` as the tiebreaker for
 * the `ROW_NUMBER() OVER (PARTITION BY post_id ORDER BY created_at ASC, id
 * ASC)` top-N-per-post preview, and for `listReplies`'s offset page). Today
 * this table only carries `IDX_community_post_replies_post_id` (a single
 * column on `post_id`) — the filter is served but the sort/window still
 * needs a separate in-memory step per post. A composite `(post_id,
 * created_at, id)` index lets Postgres serve the filter AND the order from
 * one index walk, the same "filter indexed, sort not" fix already applied to
 * `community_posts` in `1785001600000-AddCommunityPostsFeedOrderIndex.ts`.
 *
 * `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block
 * ("`CREATE INDEX`", PostgreSQL manual); this project's migration runner
 * uses `migrationsTransactionMode: 'each'` (`src/data-source.ts`), so a
 * migration opting out via `transaction = false` runs standalone without
 * needing a separate `--transaction none` invocation.
 */
export class AddCommunityPostRepliesOrderIndex1785700300000 implements MigrationInterface {
  name = 'AddCommunityPostRepliesOrderIndex1785700300000';

  // Runs outside a transaction for `CREATE INDEX CONCURRENTLY`; requires
  // `migrationsTransactionMode: 'each'` (data-source.ts). Re-runnability comes
  // from the deploy preflight dropping invalid indexes, not `IF NOT EXISTS`
  // (forbidden here — hides drift). See 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_community_post_replies_feed_order" ` +
        `ON "community_post_replies" ("post_id", "created_at", "id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_community_post_replies_feed_order"`,
    );
  }
}
