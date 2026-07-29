import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Narrows `created_at` on `community_posts`, `forum_thread`, and `events`
 * from Postgres's default `timestamptz` (microsecond precision) to
 * `timestamptz(3)` (millisecond precision) — the precision the JS `Date`
 * cursor in `common/cursor-pagination.ts` already carries.
 *
 * ---------------------------------------------------------------------------
 * Why this exists: the immutability gotcha with a functional index
 * ---------------------------------------------------------------------------
 * `FeedService`/`ForumThreadsService` paginate these three tables through
 * `cursorPaginate`, which — until this change — wrapped every ORDER BY/WHERE
 * on `created_at` in `date_trunc('milliseconds', created_at)` so a
 * millisecond-resolution cursor could never silently drop a same-millisecond,
 * nonzero-microsecond row at a page boundary (see the CORRECTNESS NOTE in
 * `cursor-pagination.ts`). The obvious-looking fix — a functional index on
 * `date_trunc('milliseconds', created_at)` — does NOT work: `date_trunc` over
 * a `timestamptz` argument is only STABLE (its result depends on the session's
 * `TimeZone` setting), not IMMUTABLE, and Postgres flatly refuses to build an
 * index on a non-immutable expression ("`CREATE INDEX`", PostgreSQL manual).
 *
 * The correct fix is this migration: once the column itself is
 * `timestamptz(3)`, Postgres rounds every stored value to millisecond
 * precision at write time, so the raw column already matches the cursor's
 * resolution — the `date_trunc` wrapper becomes unnecessary, and ordering/
 * filtering can go straight through a plain, indexable `(created_at, id)`
 * expression. `cursor-pagination.ts`'s `createdAtColumnIsMillisecondPrecision`
 * flag is flipped to `true` for exactly these three entities in
 * `FeedService`/`ForumThreadsService`. The indexes that make this pay off are
 * added separately in `1785001500000-AddFeedCursorIndexes.ts`, via
 * `CREATE INDEX CONCURRENTLY` in its own non-transactional run.
 *
 * ---------------------------------------------------------------------------
 * Lock/rewrite caveat
 * ---------------------------------------------------------------------------
 * `ALTER COLUMN ... TYPE timestamptz(3)` is a precision-narrowing cast (not a
 * binary-coercible no-op), so Postgres rewrites the table and holds an
 * ACCESS EXCLUSIVE lock for the duration — blocking reads and writes on that
 * table until it completes. At this project's current scale (~10k-user
 * ceiling), `community_posts`/`forum_thread`/`events` are all small enough
 * that this should be sub-second, but run it in a low-traffic window rather
 * than assuming it's free — this migration does NOT use `CONCURRENTLY`
 * (Postgres has no concurrent `ALTER COLUMN TYPE`), and it runs inside this
 * project's default shared migration transaction like any other DDL change.
 *
 * No existing row's ordering changes: rounding microseconds down to
 * milliseconds can only make equal-or-earlier same-millisecond rows compare
 * equal on `created_at`, which is exactly the case the `id` tie-break in
 * `cursorPaginate`'s `(createdAt, id)` ordering was already written to
 * disambiguate.
 */
export class NarrowCursorCreatedAtPrecision1785001400000
  implements MigrationInterface
{
  name = 'NarrowCursorCreatedAtPrecision1785001400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ALTER COLUMN "created_at" TYPE timestamptz(3)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ALTER COLUMN "created_at" TYPE timestamptz`,
    );
  }
}
