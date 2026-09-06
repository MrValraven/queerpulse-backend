// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * C6 / PRD-162 — the index behind the reply list's new `top` sort.
 *
 * `IDX_forum_post_thread_id_vote_count_created_at_id`
 * (`thread_id, vote_count DESC, created_at ASC, id ASC`).
 *
 * WHY. The reply sort bar used to be entirely client-side: "Newest" reversed
 * whatever had loaded and "Most helpful" ranked it on a demo-only flag with a
 * like-count fallback. Replies arrive twenty at a time, so on a sixty-reply
 * thread "Newest" showed the twenty OLDEST replies, reversed, labelled newest.
 * `GET /forum/threads/:slug/posts` now takes `?sort=oldest|newest|top` and does
 * the ordering in SQL, which is the only place it can be right.
 *
 * `oldest` and `newest` need nothing new: both are `(created_at, id)` in one
 * direction or the other, and `IDX_forum_post_thread_id_created_at_id` already
 * serves them (forwards, and as a backward scan). `top` is the one that had no
 * index, and it is the expensive one, since without this it means sorting every
 * reply in the thread on every page.
 *
 * COLUMN DIRECTIONS MATTER HERE. The emitted ORDER BY is
 * `vote_count DESC, created_at ASC, id ASC` — votes descending, then the OLDEST
 * reply as the tie-break, which is the ordering nearly all of the time because
 * nearly every reply on a young thread has zero votes. An index declared all-DESC
 * or all-ASC would not match that mixed ordering and Postgres could not use it
 * for the seek, the same argument `AddForumOpDenormalization1785901100000` and
 * `AddForumThreadTopKeysetAndReplySearch1801010000000` both spell out. So the
 * directions are written out per column exactly as the query emits them.
 *
 * NOT PARTIAL. The equivalent thread-level index is partial on
 * `deleted_at IS NULL`, because every member-facing thread query carries that
 * predicate. The reply stream carries no such universal predicate: tombstoned
 * replies are still returned (rendered as `[deleted]`), so a partial index here
 * would cover fewer rows than the query needs and be unusable.
 *
 * NON-TRANSACTIONAL. `forum_post` carries production traffic and grows with
 * every reply anyone writes, so the index is built `CONCURRENTLY`, which
 * Postgres forbids inside a transaction block. That is what `transaction = false`
 * opts out of, honored because `data-source.ts` sets
 * `migrationsTransactionMode: 'each'`. Run alone:
 *
 *   pnpm run typeorm migration:run -- --transaction none
 *
 * Re-runnability comes from the deploy preflight dropping invalid indexes, not
 * from `IF NOT EXISTS` guards (forbidden here: they hide drift, see CLAUDE.md).
 */
export class AddForumPostTopKeyset1804010000000 implements MigrationInterface {
  name = 'AddForumPostTopKeyset1804010000000';

  // See the class docstring: `CREATE INDEX CONCURRENTLY` cannot run inside a
  // transaction block.
  transaction = false as const;

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE INDEX CONCURRENTLY "IDX_forum_post_thread_id_vote_count_created_at_id" ` +
        `ON "forum_post" ("thread_id", "vote_count" DESC, "created_at" ASC, "id" ASC)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX CONCURRENTLY "IDX_forum_post_thread_id_vote_count_created_at_id"`,
    );
  }
}
