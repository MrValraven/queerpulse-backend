// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-132 — repairs the drift in `forum_thread.reply_count`.
 *
 * THE BUG THIS CLEANS UP AFTER. `reply_count` was only ever incremented, by
 * `ForumThreadsService.markActivity` on each new reply. Tombstoning a reply
 * never took it back, so a thread whose three replies had all been withdrawn
 * went on advertising "3 replies" on /forum and in the reply bar while opening
 * it showed three tombstones. `ForumPostsService.tombstonePost` and
 * `restorePost` now move the counter in both directions; this migration fixes
 * the rows that drifted before they did.
 *
 * THE DEFINITION, stated once here and matched exactly by `adjustReplyCount`:
 * a thread's `reply_count` is its posts that are NOT the opening post and NOT
 * tombstoned. The opening post has never been counted (`create` writes the
 * thread with `reply_count: 0` and its OP in the same transaction), which is
 * also why withdrawing a whole thread, whose only post-level act is tombstoning
 * the OP, must leave the count alone.
 *
 * Moderator takedowns are deliberately NOT subtracted. A hidden or removed
 * reply still occupies a row in the thread (a removed one is still rendered, as
 * `[removed]`), the moderation state lives in a different table entirely, and a
 * count that moved when a takedown landed would leak the takedown to every
 * member watching the number.
 *
 * TWO STATEMENTS, because one `UPDATE ... FROM` over a grouped subquery cannot
 * reach a thread with no `forum_post` rows at all: those threads produce no
 * group, so the join drops them and any stale count on them survives. The
 * second statement is that case, and it is why the first carries an
 * `IS NOT NULL` guard rather than a `COALESCE` that would make the two overlap.
 *
 * Both are guarded with `reply_count <> <truth>` so the migration writes only
 * the rows that are actually wrong, leaving a correct table untouched.
 *
 * IRREVERSIBLE BY NATURE. `down()` is a documented no-op: the drift it repairs
 * is corruption, not a schema shape, and the pre-migration values are exactly
 * the wrong numbers there is no reason to restore and no record from which to
 * restore them.
 */
export class BackfillForumThreadReplyCount1804020000000 implements MigrationInterface {
  name = 'BackfillForumThreadReplyCount1804020000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "forum_thread" "t"
          SET "reply_count" = "live"."reply_count"
         FROM (
           SELECT "thread_id",
                  COUNT(*) FILTER (
                    WHERE "deleted_at" IS NULL AND "is_op" = false
                  )::int AS "reply_count"
             FROM "forum_post"
            GROUP BY "thread_id"
         ) AS "live"
        WHERE "live"."thread_id" = "t"."id"
          AND "t"."reply_count" <> "live"."reply_count"`,
    );
    // Threads with no posts at all produce no group above, so they are
    // corrected separately rather than silently kept at whatever they held.
    await queryRunner.query(
      `UPDATE "forum_thread" "t"
          SET "reply_count" = 0
        WHERE "t"."reply_count" <> 0
          AND NOT EXISTS (
                SELECT 1 FROM "forum_post" "p" WHERE "p"."thread_id" = "t"."id"
              )`,
    );
  }

  public async down(): Promise<void> {
    // Intentionally empty. See the class docstring: this migration repairs
    // drifted counters, and the values it replaced were wrong by definition.
  }
}
