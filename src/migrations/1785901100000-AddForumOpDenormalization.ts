import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Denormalizes the thread-list "opening post" (OP) fields (spec
 * `2026-08-04-forum-fixes-design.md`) so the list page can render OP upvotes
 * and offer a `top` sort without an N+1 join per row:
 *
 *  - `forum_post.is_op boolean NOT NULL DEFAULT false` — marks each thread's
 *    oldest post. Backfilled true for the oldest post per thread (by
 *    `created_at`, ties broken by `id`), matching how the OP was defined by
 *    ordering alone before this flag existed. Going forward the flag is set at
 *    OP-create time (Wave 2 `ForumThreadsService`).
 *  - `forum_thread.op_vote_count int NOT NULL DEFAULT 0` — a mirror of the OP
 *    post's `vote_count`, kept in sync on vote (Wave 2 `ForumPostsService`).
 *    Backfilled from each thread's OP.
 *  - Two keyset (seek) indexes for the new sorts, matching the tuple ordering
 *    `cursor-pagination.ts` emits: `IDX_forum_thread_op_vote_count_id`
 *    (`op_vote_count DESC, id DESC`) for `top`, and
 *    `IDX_forum_thread_last_activity_id` (`last_activity_at DESC, id DESC`) for
 *    `active` (the `last_activity_at` column already existed but was unindexed).
 *    Both index the `id` tie-breaker DESC — the same direction as the leading
 *    column — because `cursorPaginate`'s keyset orders `id` in the keyset's
 *    direction (DESC here). An `id ASC` tie-break (the column default) would
 *    NOT match that ORDER BY, so Postgres could not use the index for the seek
 *    and `top`/`active` would degrade to a full sort.
 *  - `last_activity_at` is narrowed from plain `timestamptz` (microsecond) to
 *    `timestamptz(3)` (millisecond): the `active` keyset compares the raw column
 *    against a millisecond cursor (`cursorPaginate` builds it from a JS `Date`),
 *    so the stored value must round to the same resolution or a same-millisecond
 *    row with nonzero microseconds could fall through the page boundary. This
 *    makes that invariant schema-enforced, not convention (same argument as
 *    `1785001400000-NarrowCursorCreatedAtPrecision.ts` for `created_at`).
 *
 * All DDL is plain/transactional (no `CONCURRENTLY`): the two `ADD COLUMN`s use
 * constant defaults (fast, metadata-only), and running the column adds, the
 * backfills, and the index builds in one transaction means a partial failure
 * rolls back to a clean state rather than leaving a column populated but
 * unindexed (or vice versa). If this ever needs to run against a
 * high-traffic `forum_thread`, split the two `CREATE INDEX`es into a separate
 * `CONCURRENTLY`, non-transactional migration per the
 * migration-transaction-mode runbook.
 */
export class AddForumOpDenormalization1785901100000 implements MigrationInterface {
  name = 'AddForumOpDenormalization1785901100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // 1. forum_post.is_op + backfill the oldest post per thread.
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "is_op" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(`
      UPDATE "forum_post" AS p
      SET "is_op" = true
      FROM (
        SELECT DISTINCT ON ("thread_id") "id"
        FROM "forum_post"
        ORDER BY "thread_id", "created_at" ASC, "id" ASC
      ) AS op
      WHERE p."id" = op."id"
    `);

    // 2. forum_thread.op_vote_count + backfill from each thread's OP post.
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "op_vote_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(`
      UPDATE "forum_thread" AS t
      SET "op_vote_count" = p."vote_count"
      FROM "forum_post" AS p
      WHERE p."thread_id" = t."id" AND p."is_op" = true
    `);

    // 3. Narrow `last_activity_at` to millisecond precision so the raw column
    // agrees with the millisecond cursor the `active` keyset seeks on (see the
    // class docstring). Done before indexing so the index is built on the
    // narrowed column.
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "last_activity_at" TYPE timestamptz(3)`,
    );

    // 4. Keyset indexes for the `top` and `active` sorts. `id` is indexed DESC
    // (same direction as the leading column) to match `cursorPaginate`'s ORDER
    // BY — an `id ASC` tie-break would make the index unusable for the seek.
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_op_vote_count_id" ON "forum_thread" ("op_vote_count" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_last_activity_id" ON "forum_thread" ("last_activity_at" DESC, "id" DESC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_last_activity_id"`);
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_op_vote_count_id"`);
    // Revert the precision narrowing back to the plain `timestamptz` the
    // `AddForum` migration created.
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "last_activity_at" TYPE timestamptz`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "op_vote_count"`,
    );
    await queryRunner.query(`ALTER TABLE "forum_post" DROP COLUMN "is_op"`);
  }
}
