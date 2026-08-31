import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * DISC-5 — gives `topic_post` an optional back-link to the `forum_thread` it
 * was materialized from, so a thread tagged with a topic's own tag can be
 * linked into that topic's page (`TopicPostLinkService`, content module)
 * instead of the two staying permanently disconnected (the gap
 * `topic-post.entity.ts`'s docstring itself documented).
 *
 * NULLABLE: every pre-existing row is seed editorial content with no thread
 * behind it (same posture as `author_id`, see
 * `1782800720000-AddTopicPostAuthor`), and a future topic_post could still be
 * hand-curated rather than thread-derived.
 *
 * `ON DELETE CASCADE`, unlike `author_id`'s `SET NULL`: a thread-linked
 * `topic_post` row has no independent editorial existence — it mirrors the
 * thread it was materialized from, so deleting the thread should remove its
 * mirror rather than leave an orphaned card pointing at a dead `/thread/:slug`.
 *
 * The partial UNIQUE index makes linking idempotent at the DB level — the same
 * (topic, thread) pair can only ever back one row — mirroring
 * `UQ_topic_follows`'s idempotency rationale in `topic-follow.entity.ts`.
 */
export class AddTopicPostForumThreadLink1792400000000 implements MigrationInterface {
  name = 'AddTopicPostForumThreadLink1792400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "topic_post" ADD "forum_thread_id" uuid`,
    );

    await queryRunner.query(`
      ALTER TABLE "topic_post" ADD CONSTRAINT "FK_topic_post_forum_thread_id"
        FOREIGN KEY ("forum_thread_id") REFERENCES "forum_thread"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);

    // Idempotent linking: at most one `topic_post` row per (topic, thread).
    await queryRunner.query(`
      CREATE UNIQUE INDEX "UQ_topic_post_topic_id_forum_thread_id"
        ON "topic_post" ("topic_id", "forum_thread_id")
        WHERE "forum_thread_id" IS NOT NULL
    `);

    // Reverse lookup ("does this thread already have topic_post rows?"),
    // partial like `IDX_topic_post_author_id` for the same reason — most rows
    // stay NULL (seed content), so indexing them would be pure overhead.
    await queryRunner.query(`
      CREATE INDEX "IDX_topic_post_forum_thread_id"
        ON "topic_post" ("forum_thread_id")
        WHERE "forum_thread_id" IS NOT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_topic_post_forum_thread_id"`);
    await queryRunner.query(
      `DROP INDEX "UQ_topic_post_topic_id_forum_thread_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_post" DROP CONSTRAINT "FK_topic_post_forum_thread_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "topic_post" DROP COLUMN "forum_thread_id"`,
    );
  }
}
