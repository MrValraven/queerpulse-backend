import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Edit/delete/restore/history support for forum posts.
 *
 * - `forum_post.edited_at` / `forum_post.deleted_at` — nullable timestamps.
 *   `deleted_at` is a SOFT tombstone: the row and its `body` survive so a
 *   post can be restored and its history read (see `ForumPostsService`).
 * - `forum_post_edit` — one row per edit, snapshotting the pre-edit values.
 *   `previous_title` is set only for OP thread-title edits; `previous_body`
 *   for body edits. `editor_id` FK is `ON DELETE SET NULL` (a revision must
 *   outlive its editor's account erasure, mirroring
 *   `AddTopicPostAuthor`'s reasoning); `post_id` FK is `ON DELETE CASCADE`
 *   (revisions are meaningless without their post).
 */
export class AddForumPostEditsAndSoftDelete1782800900000 implements MigrationInterface {
  name = 'AddForumPostEditsAndSoftDelete1782800900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(`
      CREATE TABLE "forum_post_edit" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "previous_body" text NOT NULL,
        "previous_title" text,
        "editor_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_forum_post_edit" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_forum_post_edit_post_id" ON "forum_post_edit" ("post_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_post_edit" ADD CONSTRAINT "FK_forum_post_edit_post_id"
        FOREIGN KEY ("post_id") REFERENCES "forum_post"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "forum_post_edit" ADD CONSTRAINT "FK_forum_post_edit_editor_id"
        FOREIGN KEY ("editor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post_edit" DROP CONSTRAINT "FK_forum_post_edit_editor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post_edit" DROP CONSTRAINT "FK_forum_post_edit_post_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_forum_post_edit_post_id"`);
    await queryRunner.query(`DROP TABLE "forum_post_edit"`);
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP COLUMN "deleted_at"`,
    );
    await queryRunner.query(`ALTER TABLE "forum_post" DROP COLUMN "edited_at"`);
  }
}
