// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Clears `topic_post.author_id` on every row linked to an anonymous,
 * non-official forum thread. `TopicPostLinkService.linkThread` now writes
 * NULL there, since the thread's writer is hidden and no row keyed on them
 * may be left for a block or mute filter, or any later reader, to match.
 * This brings the rows written before that change in line with it.
 * `TopicsService.listPosts` already compares NULL for these rows on read
 * (`TOPIC_POST_AUTHOR_FILTER_COLUMN_SQL`), so this changes nothing a viewer
 * sees. It removes the stored link between the writer and the thread.
 *
 * Official threads keep their staff writer, the same rule the forum list
 * follows (`forum-author-filter.ts`). Editorial rows (`forum_thread_id IS
 * NULL`) are untouched.
 *
 * `down` writes nothing: restoring the ids would put the hidden writer back
 * on rows the read and write paths both keep them off, and the ids are gone
 * once cleared.
 */
export class ClearAnonymousTopicPostAuthors1840850000000 implements MigrationInterface {
  name = 'ClearAnonymousTopicPostAuthors1840850000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "topic_post" "tp"
        SET "author_id" = NULL
        FROM "forum_thread" "thread"
        WHERE "thread"."id" = "tp"."forum_thread_id"
          AND "thread"."is_anonymous"
          AND NOT "thread"."is_official"
          AND "tp"."author_id" IS NOT NULL
    `);
  }

  public async down(): Promise<void> {
    // Intentionally empty, see the class doc.
  }
}
