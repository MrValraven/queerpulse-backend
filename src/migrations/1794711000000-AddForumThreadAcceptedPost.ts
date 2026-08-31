import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_thread.accepted_post_id`: the reply the thread's author marked as the
 * answer (SOC-13).
 *
 * The sort menu has offered "unanswered" since the forum shipped, but there was
 * no answered concept for it to be the negation of: it filtered on
 * `reply_count = 0`, so a question with forty replies and no resolution counted
 * as answered. The archive therefore never resolved into anything reusable.
 * `ForumThreadsService.list` now reads `accepted_post_id IS NULL` for that
 * sort, which is what the label has always claimed.
 *
 * `ON DELETE SET NULL`, not CASCADE: the accepted post is a *pointer*, so a
 * hard-deleted post must clear the mark and leave the thread standing. (An
 * ordinary member delete is a soft tombstone, which this column never sees;
 * `ForumThreadsService.setAcceptedPost` refuses to mark a tombstoned post, and
 * the read path drops the mark from a post that was tombstoned afterwards.)
 *
 * `IDX_forum_thread_unanswered_created_at_id` is a PARTIAL keyset index over
 * exactly the rows the `unanswered` sort can return. That sort uses
 * `cursorPaginate`'s default `(created_at DESC, id DESC)` keyset, so the
 * column order and both directions match it verbatim — the same contract
 * `IDX_forum_thread_created_at_id` holds for the unfiltered `new` sort. Partial
 * rather than a plain index on `accepted_post_id`: the predicate selects the
 * overwhelming majority of rows, so an index on the column itself would never
 * be chosen, while a partial keyset lets the sort seek instead of filtering
 * after the fact.
 *
 * No `CREATE INDEX CONCURRENTLY`: this file also runs transactional DDL
 * (`ALTER TABLE`), and the two cannot share a migration (see the
 * migration-transaction runbook). The table is small enough that the brief
 * write lock is acceptable; if it ever is not, split the index into its own
 * non-transactional migration rather than mixing modes here.
 */
export class AddForumThreadAcceptedPost1794711000000 implements MigrationInterface {
  name = 'AddForumThreadAcceptedPost1794711000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "accepted_post_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_thread" ADD CONSTRAINT "FK_forum_thread_accepted_post"
        FOREIGN KEY ("accepted_post_id") REFERENCES "forum_post"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_unanswered_created_at_id"
        ON "forum_thread" ("created_at" DESC, "id" DESC)
        WHERE "accepted_post_id" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_forum_thread_unanswered_created_at_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP CONSTRAINT "FK_forum_thread_accepted_post"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "accepted_post_id"`,
    );
  }
}
