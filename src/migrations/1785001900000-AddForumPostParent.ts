import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Self-referential `forum_post.parent_post_id` — the column the Reddit-style
 * nested-replies feature hangs on. `NULL` means a top-level comment on the
 * thread; a value means a reply to that specific post within the same
 * thread. The FK is `ON DELETE SET NULL` (mirroring the soft-tombstone
 * approach in `AddForumPostEditsAndSoftDelete`) rather than `CASCADE` — a
 * deleted parent should not silently delete its replies; they re-parent to
 * the thread root instead.
 *
 * `forum_post` already carries production traffic, so this migration avoids
 * both a build-lock and a validation-lock:
 *
 * - The FK is added `NOT VALID` (a brief lock that skips the full-table scan)
 *   and validated in a SEPARATE `VALIDATE CONSTRAINT` step, which takes only
 *   `SHARE UPDATE EXCLUSIVE` and does not block concurrent writes ("ALTER
 *   TABLE", PostgreSQL manual). A plain `ADD CONSTRAINT` would scan every row
 *   under a write-blocking lock.
 * - The `(thread_id, parent_post_id)` index — which supports fetching all
 *   replies (direct + nested) for a thread ordered by their parent, without a
 *   `COUNT(*)`/tree-walk join — is built `CONCURRENTLY`, not with a plain
 *   `CREATE INDEX` that would lock writes for the whole build.
 *
 * Both rely on this migration running OUTSIDE a transaction (`CONCURRENTLY`
 * cannot run inside a transaction block at all). See the `transaction = false`
 * flag below and `1785001500000-AddFeedCursorIndexes.ts` for the full writeup.
 */
export class AddForumPostParent1785001900000 implements MigrationInterface {
  name = 'AddForumPostParent1785001900000';

  // `CREATE INDEX CONCURRENTLY` cannot run inside a transaction block, so this
  // migration opts out of the per-migration transaction. Only honored under
  // `migrationsTransactionMode: 'each'` (set in data-source.ts) — under the
  // default `all` mode TypeORM rejects this override outright. Running outside
  // a transaction also lets the `NOT VALID` add and the `VALIDATE` commit
  // separately, so validation never rides inside the same lock as the add.
  // Re-runnability comes from the deploy preflight dropping invalid indexes,
  // not `IF NOT EXISTS` guards (forbidden here — they hide drift). See
  // 1785001500000.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "parent_post_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD CONSTRAINT "FK_forum_post_parent_post_id" ` +
        `FOREIGN KEY ("parent_post_id") REFERENCES "forum_post"("id") ` +
        `ON DELETE SET NULL ON UPDATE NO ACTION NOT VALID`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" VALIDATE CONSTRAINT "FK_forum_post_parent_post_id"`,
    );
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_thread_id_parent_post_id" ` +
        `ON "forum_post" ("thread_id", "parent_post_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_post_thread_id_parent_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP CONSTRAINT "FK_forum_post_parent_post_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP COLUMN "parent_post_id"`,
    );
  }
}
