// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-133 — removes every upvote a member cast on their own forum post, and
 * re-syncs the two denormalized counters that were carrying them.
 *
 * WHY THEY GO. `POST /forum/posts/:id/vote` loaded the post by id and did
 * nothing else: no self-vote guard at all. Authors could upvote their own
 * opening post, and `ForumPostsService.assertCanVote` now refuses that in
 * BOTH directions, which also means an author has no way left to clear one
 * they already cast. Leaving them would freeze exactly the votes the guard
 * exists to prevent, permanently, in the one number the forum ranks on:
 * `paginateTop` (PRD-161) made `top` a real ranked ordering, so an old
 * self-vote is not inert history, it is a live thumb on the scale that
 * nobody can lift.
 *
 * Nothing legitimate is lost. A self-vote carries no information by
 * construction (everyone rates their own post highly), and every OTHER
 * member's vote is untouched, so a genuinely popular post keeps every vote
 * that meant anything.
 *
 * WHY ARCHIVE RATHER THAN DELETE OUTRIGHT. This is the one migration in the
 * section-5 batch that destroys member-authored rows, and a bare `DELETE`
 * would make `down()` a lie: there would be nothing to restore from, and the
 * original ids and timestamps would be gone with them. Copying the rows into
 * `forum_post_self_vote_archive` first costs one small table and buys three
 * things: the deletion is auditable after the fact, `down()` genuinely
 * reverses (same ids, same timestamps), and if the self-vote count turns out
 * to be larger or stranger than expected it can be inspected rather than
 * guessed at. Drop the table by hand once the result has been eyeballed.
 *
 * FIVE STATEMENTS, IN THIS ORDER, all inside the migration's transaction so
 * a failure leaves neither the archive nor the counters half-written:
 *
 *  1. create the archive table;
 *  2. copy the self-vote rows into it, ids and timestamps preserved;
 *  3. delete them from `forum_post_vote`;
 *  4. re-derive `forum_post.vote_count` from the surviving rows, for the
 *     posts whose count no longer matches. Re-derived rather than
 *     decremented, so it also absorbs any unrelated drift on those rows;
 *  5. mirror the opening posts' fresh counts onto `forum_thread.op_vote_count`,
 *     the denormalized copy `vote()` keeps in step and the `top` thread sort
 *     actually orders by. Skipping this would leave the thread list ranking
 *     on the old, inflated number while the post itself showed the corrected
 *     one.
 *
 * Steps 4 and 5 both read `forum_post_vote` AFTER step 3, so they see the
 * post-delete truth. Step 5 reads `forum_post.vote_count`, which step 4 has
 * already corrected.
 */
export class StripForumSelfVotes1804030000000 implements MigrationInterface {
  name = 'StripForumSelfVotes1804030000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    // No FKs to `forum_post` or `users`: this table has to survive the post
    // or the account being deleted, otherwise the audit trail evaporates on
    // exactly the cascade that makes someone want to read it.
    await queryRunner.query(
      `CREATE TABLE IF NOT EXISTS "forum_post_self_vote_archive" (
         "id" uuid NOT NULL,
         "post_id" uuid NOT NULL,
         "user_id" uuid NOT NULL,
         "value" smallint NOT NULL,
         "created_at" timestamptz NOT NULL,
         "archived_at" timestamptz NOT NULL DEFAULT now(),
         CONSTRAINT "PK_forum_post_self_vote_archive" PRIMARY KEY ("id")
       )`,
    );

    await queryRunner.query(
      `INSERT INTO "forum_post_self_vote_archive"
              ("id", "post_id", "user_id", "value", "created_at")
       SELECT "v"."id", "v"."post_id", "v"."user_id", "v"."value", "v"."created_at"
         FROM "forum_post_vote" "v"
         JOIN "forum_post" "p" ON "p"."id" = "v"."post_id"
        WHERE "p"."author_id" = "v"."user_id"
       ON CONFLICT ("id") DO NOTHING`,
    );

    await queryRunner.query(
      `DELETE FROM "forum_post_vote" "v"
        USING "forum_post" "p"
        WHERE "p"."id" = "v"."post_id"
          AND "p"."author_id" = "v"."user_id"`,
    );

    await this.resyncVoteCounts(queryRunner);
  }

  /**
   * Puts the archived rows back with their original ids and timestamps,
   * re-derives both counters, and drops the archive table, which after the
   * restore holds nothing that is not live again.
   *
   * `ON CONFLICT DO NOTHING` guards the case where someone re-cast a vote
   * between `up()` and `down()`. That cannot happen through the API, since
   * `assertCanVote` refuses a self-vote, but a manual insert or a future
   * relaxation should not turn a rollback into a constraint violation.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    const archivePresence = (await queryRunner.query(
      `SELECT to_regclass('public.forum_post_self_vote_archive') IS NOT NULL AS "exists"`,
    )) as { exists: boolean }[];
    if (!archivePresence[0]?.exists) {
      return;
    }

    await queryRunner.query(
      `INSERT INTO "forum_post_vote"
              ("id", "post_id", "user_id", "value", "created_at")
       SELECT "a"."id", "a"."post_id", "a"."user_id", "a"."value", "a"."created_at"
         FROM "forum_post_self_vote_archive" "a"
         JOIN "forum_post" "p" ON "p"."id" = "a"."post_id"
       ON CONFLICT DO NOTHING`,
    );

    await this.resyncVoteCounts(queryRunner);

    await queryRunner.query(
      `DROP TABLE IF EXISTS "forum_post_self_vote_archive"`,
    );
  }

  /**
   * Re-derives `forum_post.vote_count` from the surviving votes, then mirrors
   * every opening post's fresh count onto its thread. Shared by `up()` and
   * `down()` so the two directions cannot drift into different arithmetic.
   */
  private async resyncVoteCounts(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "forum_post" "p"
          SET "vote_count" = "live"."vote_count"
         FROM (
           SELECT "p2"."id",
                  (
                    SELECT COUNT(*)::int
                      FROM "forum_post_vote" "v"
                     WHERE "v"."post_id" = "p2"."id" AND "v"."value" = 1
                  ) AS "vote_count"
             FROM "forum_post" "p2"
         ) AS "live"
        WHERE "live"."id" = "p"."id"
          AND "p"."vote_count" <> "live"."vote_count"`,
    );

    await queryRunner.query(
      `UPDATE "forum_thread" "t"
          SET "op_vote_count" = "op"."vote_count"
         FROM "forum_post" "op"
        WHERE "op"."thread_id" = "t"."id"
          AND "op"."is_op" = true
          AND "t"."op_vote_count" <> "op"."vote_count"`,
    );
  }
}
