// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_thread.deleted_at` / `deleted_by_id`: the thread's own soft delete
 * (PRD-160).
 *
 * WHY. Until now the forum's only "delete" reached one POST. Deleting your
 * opening post tombstoned that row and left the THREAD entirely intact: the
 * full title still sat on /forum, still counted toward the category badges,
 * still went out in every member's feed, and still answered on its own URL,
 * with nothing changed but a body reading "[deleted]". So a member who asked
 * where to find trans-affirming healthcare, or posted a housing ask they
 * regretted the moment they hit send, could blank the words and still watch the
 * question itself broadcast platform-wide with their name attached, with no way
 * at all to take it down. On a platform whose members are often not out
 * everywhere, that is the difference between a mistake and a disclosure.
 *
 * SOFT, NEVER A ROW DELETE, for three reasons: the replies underneath are other
 * people's words and are left standing; a report or appeal filed against the
 * thread has to still have something to point at, so platform staff keep seeing
 * withdrawn threads on every read path; and a hard delete would have to decide
 * what happens to votes, edit history and the accepted-answer pointer, none of
 * which "I want this off the forum" is asking about.
 *
 * `deleted_by_id` records WHO, exactly as `forum_post.deleted_by_id` does (see
 * `AddContentTombstoneActor1793520000000`): an author withdrawing their own
 * thread and a moderator taking one down are different facts, and an appeal has
 * to be able to tell them apart. Deliberately carries NO foreign key, matching
 * the `forum_post` column it mirrors: the record of who withdrew a thread must
 * survive that person's account being erased, and the column is read only to
 * label the action, never to join a profile.
 *
 * Both columns are plain nullable `ADD COLUMN`s with no default, so this is a
 * metadata-only catalog change: no table rewrite, no backfill, no lock held for
 * longer than the statement itself. Transactional for that reason, and because
 * either both columns should exist or neither should. The index work this
 * enables ships separately, in
 * `1801010000000-AddForumThreadTopKeysetAndReplySearch`, which has to run
 * outside a transaction for `CREATE INDEX CONCURRENTLY`.
 */
export class AddForumThreadSoftDelete1801000000000 implements MigrationInterface {
  name = 'AddForumThreadSoftDelete1801000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "deleted_by_id" uuid`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "deleted_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "deleted_at"`,
    );
  }
}
