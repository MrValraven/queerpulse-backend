// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two forum indexes and one retirement, for the sort fix (PRD-161) and the
 * search fix (C9/PRD-164). Depends on `AddForumThreadSoftDelete1801000000000`,
 * which adds the `deleted_at` column the first index is partial on.
 *
 * 1. `IDX_forum_thread_top_keyset`
 *    (`op_vote_count DESC, last_activity_at DESC, id DESC`,
 *    `WHERE deleted_at IS NULL`).
 *
 *    The `top` sort used to order `op_vote_count DESC, id DESC`, which is not
 *    an ordering at all on a young forum: almost every thread has zero votes,
 *    so almost every thread was ordered by a random uuid. The forum's landing
 *    page (`top` is what the frontend opened on) was a shuffled list that never
 *    changed as people posted, and a thread from a minute ago sat below
 *    anything that had ever collected a single upvote.
 *    `ForumThreadsService.paginateTop` now orders on all three columns, so the
 *    zero-vote tail falls back to recency, and this index is what serves that
 *    ORDER BY. All three columns descend, matching the emitted ORDER BY exactly
 *    — `id ASC` (the column default) would not match and Postgres could not use
 *    the index for the seek, the same argument
 *    `AddForumOpDenormalization1785901100000` spells out for the two-column
 *    version.
 *
 *    PARTIAL on `deleted_at IS NULL` because every member-facing browse query
 *    now carries that predicate (PRD-160), so the index covers exactly the rows
 *    the sort can return and shrinks rather than grows as threads are
 *    withdrawn. A platform moderator's browse omits the predicate and so cannot
 *    use this index; that is a rare query by a handful of accounts and is not
 *    worth a second, whole-table copy of the same three columns.
 *
 * 2. `IDX_forum_post_body_trgm` (GIN, `gin_trgm_ops`, on `forum_post.body`).
 *
 *    The forum's own search box matched thread TITLES only, so a question that
 *    was answered in a reply came back empty from the box sitting right above
 *    the answer, while the global search bar in the header (a different code
 *    path, `ForumPostsService.searchByText`, full-text over post bodies) found
 *    it. `ForumThreadsService.applyTextAndTagFilters` now also matches the body
 *    of any visible post in the thread, as a correlated EXISTS.
 *
 *    That branch is a leading-wildcard `ILIKE '%term%'`, which no btree can
 *    serve — see `AddSearchTrgmAndTagsIndexes1785700100000`, which enabled
 *    `pg_trgm` and added exactly this shape of index for the five other
 *    unindexed `ILIKE` scans in the app. This is the sixth, and by far the
 *    largest table of them, since `forum_post` grows with every reply anyone
 *    ever writes. Trigram indexes only help patterns with three or more literal
 *    characters; a one or two character search term still falls back to a scan,
 *    which is strictly what happens today for every term, so never a
 *    regression.
 *
 * 3. Retiring `IDX_forum_thread_op_vote_count_id`
 *    (`op_vote_count DESC, id DESC`).
 *
 *    It existed for exactly one query: the old two-column `top` seek. Index 1
 *    strictly supersedes it (same leading column, two more) and no other code
 *    path in the repo orders or seeks on `op_vote_count` — the column is
 *    otherwise only read off an already-fetched row. Left in place it would
 *    cost every insert, every reply-driven update and every vote on an opening
 *    post, forever, to serve nothing.
 *
 * NON-TRANSACTIONAL. `forum_thread` and `forum_post` both carry production
 * traffic, so every index here is built (and the dead one dropped)
 * `CONCURRENTLY`, which Postgres forbids inside a transaction block. That is
 * what `transaction = false` opts out of, honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * Re-runnability comes from the deploy preflight dropping invalid indexes, not
 * from `IF NOT EXISTS` guards (forbidden here: they hide drift, see CLAUDE.md).
 */
export class AddForumThreadTopKeysetAndReplySearch1801010000000 implements MigrationInterface {
  name = 'AddForumThreadTopKeysetAndReplySearch1801010000000';

  // See the class docstring: `CREATE`/`DROP INDEX CONCURRENTLY` cannot run
  // inside a transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_thread_top_keyset" ` +
        `ON "forum_thread" ("op_vote_count" DESC, "last_activity_at" DESC, "id" DESC) ` +
        `WHERE "deleted_at" IS NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_body_trgm" ` +
        `ON "forum_post" USING gin ("body" gin_trgm_ops)`,
    );
    // Dropped LAST, after its replacement is live, so no window exists in which
    // the `top` sort has neither index available.
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_thread_op_vote_count_id"`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Rebuilt first, mirroring `up()`'s ordering rule in reverse.
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_thread_op_vote_count_id" ` +
        `ON "forum_thread" ("op_vote_count" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_post_body_trgm"`,
    );
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_thread_top_keyset"`,
    );
  }
}
