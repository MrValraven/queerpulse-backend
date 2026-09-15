// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The schema the forum's publish/review LIFECYCLE needs on top of the columns
 * `AddForumRichComposer1817300000000` added: one mark saying whether a thread's
 * create fan-out has already gone out, and the keyset index the moderator
 * review queue reads through.
 *
 * ## `fanned_out_at` (timestamptz(3), NULL, BACKFILLED)
 *
 * WHAT WENT WRONG WITHOUT IT. `ForumThreadsService.create` ran its whole
 * post-commit fan-out unconditionally: the `FORUM_THREAD_CREATED` profile
 * activity event, `TopicPostLinkService.linkThread` (which materializes a
 * `topic_post` row and fans DISC-3 topic-follow notifications out to everyone
 * following a matching topic), and `MentionNotificationService.notify`, whose
 * payload carries the first 140 characters of the body as `excerpt`. For a
 * thread created with a future `published_at`, or with `review_state =
 * 'pending'`, all three fired the instant the row committed. The LINK 404s
 * behind the read gate, so that half held; the EXCERPT is the disclosure, and
 * it reached other members before the thread was visible and, in the review
 * case, before a moderator had read a word of it. Pre-publish review exists on
 * this platform precisely so a sensitive post is seen by a moderator first, so
 * that was the feature defeating itself.
 *
 * Simply suppressing the fan-out for those two cases is worse, not better:
 * nothing would ever re-fire it, so a scheduled thread would go live having
 * silently swallowed every mention and every topic-follow notification it owed.
 * The fan-out has to be DEFERRED, and a deferred side effect needs a durable
 * "already done" mark or it fires twice the first time two requests observe the
 * thread at once.
 *
 * WHY A NULLABLE TIMESTAMP AND NOT A BOOLEAN. The same width once Postgres has
 * aligned the row, and it answers a second question for free: WHEN the fan-out
 * actually went out, which for a scheduled thread is not `published_at` (the
 * instant it became eligible) and not `created_at` (the instant it was written).
 * When a mention arrives late, that column is the only place the answer lives.
 *
 * NULL means "owed, not yet sent". `ForumThreadsService.publishThread` claims
 * it with a single conditional `UPDATE ... WHERE id = $1 AND fanned_out_at IS
 * NULL`, and only the caller whose statement reports one affected row fans out.
 * Under READ COMMITTED two concurrent claims serialize on the row lock and the
 * loser re-evaluates the predicate against the committed value, so it matches
 * nothing. That is the whole concurrency argument: no advisory lock, no
 * transaction, no second table.
 *
 * BACKFILLED TO `created_at` FOR EVERY EXISTING ROW, and the backfill is what
 * makes this safe to deploy. Every thread written before this migration fanned
 * out at create time, so leaving them NULL would mean the first person to open
 * any old thread re-fires its mentions and its topic-follow notifications,
 * years late. `created_at` is a statement of fact for those rows: fan-out
 * happened in the same request that wrote them.
 *
 * NULLABLE rather than NOT NULL, unlike `published_at` in the migration before
 * this one. Here NULL is a real, load-bearing state ("owed") that new rows are
 * deliberately written in, so there is nothing to tighten and no NULL check
 * being pushed into a read path: the only reader is a service that is asking
 * exactly the question NULL answers.
 *
 * NO INDEX on it. Nothing ever queries `WHERE fanned_out_at IS NULL`: the mark
 * is read off a thread row the caller already holds, and claimed by primary
 * key. An index would be write cost paid against a query nobody wrote.
 *
 * ## `IDX_forum_thread_review_pending_created_at_id`
 *
 * `AddForumRichComposer1817300000000` deliberately did NOT add an index on
 * `review_state = 'pending'`, and said why: no read path existed, and the index
 * belonged in the migration that ships the queue, sized against the queue's
 * real ORDER BY. This is that migration. `GET /admin/forum/review` pages
 * newest-first through `ForumThreadsService.listPendingReview`, which goes
 * through `cursorPaginate`'s default keyset, so the ORDER BY is
 * `created_at DESC, id DESC` — matched here column for column and direction for
 * direction, since a direction mismatch makes an index unusable for a seek.
 *
 * PARTIAL on `review_state = 'pending'` alone, NOT on the full read gate. A
 * pending thread is the whole queue, and the predicate is a plain constant
 * equality (immutable, so it is indexable, unlike `published_at <= now()`).
 * The index therefore covers exactly the rows the queue can return and SHRINKS
 * as moderators work through it, which is the right shape for a backlog: an
 * empty queue costs an empty index.
 *
 * `deleted_at IS NULL` is deliberately absent from the predicate even though
 * the queue query carries it. A thread that is both pending and withdrawn is
 * vanishingly rare (the author has to submit it for review and then withdraw
 * it), so folding it in would shrink the index by nothing while making the
 * predicate one more thing that has to be emitted verbatim to match.
 *
 * ## Transactionality
 *
 * TRANSACTIONAL. Ordinary DDL plus one bounded backfill UPDATE that must land
 * with the column it fills: a committed `fanned_out_at` column whose backfill
 * rolled back would re-fan-out every thread on the forum. The index build is a
 * plain, blocking `CREATE INDEX` rather than `CONCURRENTLY`, which Postgres
 * forbids inside a transaction block — same call, same reasoning, as the
 * migration before this one, whose own backfill already established that this
 * table gets a maintenance window.
 *
 * No `IF [NOT] EXISTS` guards: re-runnability comes from the deploy preflight,
 * not from guards that would hide drift (see CLAUDE.md).
 */
export class AddForumThreadPublishLifecycle1817310000000 implements MigrationInterface {
  name = 'AddForumThreadPublishLifecycle1817310000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "forum_thread"
        ADD COLUMN "fanned_out_at" TIMESTAMP(3) WITH TIME ZONE NULL
    `);

    // Every thread that already exists fanned out in the request that created
    // it. Without this line the first read of any of them would re-fire its
    // mentions and topic-follow notifications.
    await queryRunner.query(`
      UPDATE "forum_thread" SET "fanned_out_at" = "created_at"
    `);

    await queryRunner.query(`
      CREATE INDEX "IDX_forum_thread_review_pending_created_at_id"
        ON "forum_thread" ("created_at" DESC, "id" DESC)
        WHERE "review_state" = 'pending'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_forum_thread_review_pending_created_at_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "fanned_out_at"`,
    );
  }
}
