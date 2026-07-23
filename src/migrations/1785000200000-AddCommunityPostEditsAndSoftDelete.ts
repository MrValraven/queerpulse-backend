import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Edit/delete/restore/history support for community posts AND replies
 * (sub-project #3).
 *
 * - `community_posts.edited_at` / `.deleted_at` and
 *   `community_post_replies.edited_at` / `.deleted_at` — nullable timestamps.
 *   `deleted_at` is a SOFT tombstone: the row and its `body`/`text` survive so
 *   an author (or the community's owner/mod) can restore it and its history
 *   stays readable (see `CommunityPostsService`).
 * - `community_post_edit` — one row per post-body edit, snapshotting the
 *   pre-edit body. `community_post_reply_edit` — one row per reply-text edit,
 *   snapshotting the pre-edit text. Two tables because posts and replies are
 *   separate entities (mirrors their existing `community_posts` /
 *   `community_post_replies` split). Community posts carry no title, so there
 *   is no `previous_title` column (unlike the forum's `forum_post_edit`).
 *   `editor_id` FK is `ON DELETE SET NULL` (a revision must outlive its
 *   editor's account erasure); `post_id`/`reply_id` FKs are `ON DELETE CASCADE`
 *   (revisions are meaningless without their post/reply). `DEFAULT
 *   uuid_generate_v4()` matches `1782693200000-AddCommunities.ts`.
 *
 * DO NOT RUN — authored for review only, per the program's instructions.
 */
export class AddCommunityPostEditsAndSoftDelete1785000200000 implements MigrationInterface {
  name = 'AddCommunityPostEditsAndSoftDelete1785000200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_posts" ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ADD "edited_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(`
      CREATE TABLE "community_post_edit" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "post_id" uuid NOT NULL,
        "previous_body" text NOT NULL,
        "editor_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_post_edit" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_edit_post_id" ON "community_post_edit" ("post_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_post_edit" ADD CONSTRAINT "FK_community_post_edit_post_id"
        FOREIGN KEY ("post_id") REFERENCES "community_posts"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_post_edit" ADD CONSTRAINT "FK_community_post_edit_editor_id"
        FOREIGN KEY ("editor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(`
      CREATE TABLE "community_post_reply_edit" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "reply_id" uuid NOT NULL,
        "previous_text" text NOT NULL,
        "editor_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_community_post_reply_edit" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_community_post_reply_edit_reply_id" ON "community_post_reply_edit" ("reply_id")`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_post_reply_edit" ADD CONSTRAINT "FK_community_post_reply_edit_reply_id"
        FOREIGN KEY ("reply_id") REFERENCES "community_post_replies"("id")
        ON DELETE CASCADE ON UPDATE NO ACTION
    `);
    await queryRunner.query(`
      ALTER TABLE "community_post_reply_edit" ADD CONSTRAINT "FK_community_post_reply_edit_editor_id"
        FOREIGN KEY ("editor_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_post_reply_edit" DROP CONSTRAINT "FK_community_post_reply_edit_editor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_reply_edit" DROP CONSTRAINT "FK_community_post_reply_edit_reply_id"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_community_post_reply_edit_reply_id"`,
    );
    await queryRunner.query(`DROP TABLE "community_post_reply_edit"`);

    await queryRunner.query(
      `ALTER TABLE "community_post_edit" DROP CONSTRAINT "FK_community_post_edit_editor_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_edit" DROP CONSTRAINT "FK_community_post_edit_post_id"`,
    );
    await queryRunner.query(`DROP INDEX "IDX_community_post_edit_post_id"`);
    await queryRunner.query(`DROP TABLE "community_post_edit"`);

    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP COLUMN "deleted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP COLUMN "edited_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP COLUMN "deleted_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP COLUMN "edited_at"`,
    );
  }
}
