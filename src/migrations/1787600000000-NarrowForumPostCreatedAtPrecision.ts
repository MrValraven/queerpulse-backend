import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Narrows `forum_post.created_at` from Postgres's default `timestamptz`
 * (microsecond precision) to `timestamptz(3)` (millisecond precision) — the
 * precision the JS `Date` cursor in `common/cursor-pagination.ts` already
 * carries. This is the same fix `1785001400000-NarrowCursorCreatedAtPrecision`
 * applied to `community_posts`, `forum_thread`, and `events`; `forum_post` was
 * missed at the time (see that migration's docstring for the full
 * STABLE-vs-IMMUTABLE `date_trunc` explanation).
 *
 * `ForumPostsService.paginateOldestFirst` (the keyset behind
 * `GET /forum/threads/:slug/posts`) wrapped `created_at` in
 * `date_trunc('milliseconds', created_at)` for both ORDER BY and the WHERE
 * keyset predicate to keep a millisecond-resolution cursor from silently
 * dropping a same-millisecond, nonzero-microsecond row at a page boundary.
 * That wrapper is STABLE, not IMMUTABLE, so Postgres could never use
 * `IDX_forum_post_thread_id_created_at_id` to serve the sort — every page of
 * a thread's replies forced a Sort node instead of a plain index scan. Once
 * the column itself is `timestamptz(3)`, Postgres rounds every stored value
 * to millisecond precision at write time, so the raw column already matches
 * the cursor's resolution and `paginateOldestFirst` can drop the `date_trunc`
 * wrapper entirely and ride the existing btree.
 *
 * No existing row's ordering changes: rounding microseconds down to
 * milliseconds can only make equal-or-earlier same-millisecond rows compare
 * equal on `created_at`, which is exactly the case the `id` tie-break in the
 * `(createdAt, id)` ordering was already written to disambiguate.
 *
 * Lock/rewrite caveat: `ALTER COLUMN ... TYPE timestamptz(3)` is a
 * precision-narrowing cast (not a binary-coercible no-op), so Postgres
 * rewrites the table and holds an ACCESS EXCLUSIVE lock for the duration —
 * blocking reads and writes on `forum_post` until it completes. Run it in a
 * low-traffic window rather than assuming it's free; it runs inside this
 * project's default shared migration transaction like any other DDL change
 * (Postgres has no concurrent `ALTER COLUMN TYPE`).
 */
export class NarrowForumPostCreatedAtPrecision1787600000000
  implements MigrationInterface
{
  name = 'NarrowForumPostCreatedAtPrecision1787600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
  }
}
