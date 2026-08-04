import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds free-text tags to forum threads (spec
 * `2026-08-04-forum-fixes-design.md`): a `text[]` column defaulting to the
 * empty array, plus a GIN index so the list query's `:tag = ANY(t.tags)`
 * (equivalently `t.tags @> ARRAY[:tag]`) tag filter can be served by an index
 * scan instead of a sequential scan as the table grows.
 *
 * The GIN index is migration-only (not a `@Index` decorator on
 * `ForumThread.tags`): TypeORM's `@Index` has no clean way to express an array
 * operator class, the same precedent as `profiles.tags` in
 * `1785700100000-AddSearchTrgmAndTagsIndexes.ts`. A plain (blocking)
 * `CREATE INDEX` inside the migration's transaction is used rather than
 * `CONCURRENTLY`: this migration also rewrites nothing (the column default is a
 * constant, so `ADD COLUMN` is a fast metadata-only change on modern Postgres),
 * and keeping it transactional means a failure rolls the whole thing back
 * cleanly.
 */
export class AddForumThreadTags1785901000000 implements MigrationInterface {
  name = 'AddForumThreadTags1785901000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "tags" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_thread_tags" ON "forum_thread" USING gin ("tags")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_forum_thread_tags"`);
    await queryRunner.query(`ALTER TABLE "forum_thread" DROP COLUMN "tags"`);
  }
}
