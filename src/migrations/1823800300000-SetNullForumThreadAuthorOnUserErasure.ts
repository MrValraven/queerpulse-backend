// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-494. Extends `SetNullContentAuthorFksOnUserErasure1794610000000` to the
 * forum: erasing one account was deleting every thread that member started,
 * and with it every reply other members had written underneath.
 *
 * `forum_thread.author_id` was declared `ON DELETE CASCADE` in
 * `AddForum1782800210000`, and `forum_post.thread_id` cascades from the
 * thread. So one erasure removed the thread row, and the thread row took
 * the whole conversation with it: other people's answers, votes and
 * accepted-answer marks included.
 *
 * This flips the author FK to `ON DELETE SET NULL`. The thread survives with
 * no author, and the read path renders it through `UNKNOWN_AUTHOR` (see
 * `forum-response.ts`).
 *
 * Deliberately left `ON DELETE CASCADE`:
 *
 *  - `forum_post.thread_id`: the thread now survives an erasure, so this
 *    cascade only fires on a genuine thread row delete.
 *  - `forum_post.author_id`: the erased member's own posts (their opening
 *    post included) are removed, as the delete-account page promises.
 *
 * The column becomes nullable first, since a `SET NULL` rule on a `NOT NULL`
 * column is a constraint Postgres accepts at DDL time and only fails on at
 * delete time.
 *
 * Purely transactional: `IDX_forum_thread_author_id` already exists from
 * `AddForum1782800210000`, so the `SET NULL` action finds its referencing
 * rows through an index, and `ALTER COLUMN ... DROP NOT NULL` leaves that
 * index in place.
 */
export class SetNullForumThreadAuthorOnUserErasure1823800300000 implements MigrationInterface {
  name = 'SetNullForumThreadAuthorOnUserErasure1823800300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP CONSTRAINT "FK_forum_thread_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "author_id" DROP NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_thread" ADD CONSTRAINT "FK_forum_thread_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // Same caveat as `SetNullContentAuthorFksOnUserErasure1794610000000`'s
    // down(): restoring NOT NULL only succeeds while no thread has actually
    // been orphaned by an erasure. Once an author has been erased, `SET NOT
    // NULL` correctly fails, and no id that no longer exists is invented.
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP CONSTRAINT "FK_forum_thread_author_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ALTER COLUMN "author_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_thread" ADD CONSTRAINT "FK_forum_thread_author_id"
        FOREIGN KEY ("author_id") REFERENCES "users"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
  }
}
