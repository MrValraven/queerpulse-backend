import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records WHO set a soft tombstone on community posts, community post replies
 * and forum posts (`deleted_by_id`), so a restore can tell an author's own
 * "I deleted this" apart from a moderator takedown.
 *
 * Before this, `deleted_at` was the whole tombstone and `delete` and `restore`
 * shared the same author-OR-moderator check, so the author of a post a
 * community mod (or a platform moderator, in the forum) had removed could
 * simply undo it in one request — community moderation via the delete button
 * was cosmetic (BE-COM-01).
 *
 * Nullable, no default. NULL means one of two things:
 *  - the row is not tombstoned at all (`deleted_at IS NULL`), or
 *  - it is a LEGACY tombstone written before this column existed. The services
 *    treat that case as the pre-existing author-or-staff rule rather than
 *    guessing an actor — see `CommunityPostsService.assertCanRestore` /
 *    `ForumPostsService.assertCanRestore`.
 *
 * `ON DELETE SET NULL` mirrors every other actor reference in these tables
 * (`community_posts.author_id`, `community_post_edit.editor_id`): an erased
 * moderator account must not take the content with it, and must not leave a
 * dangling uuid either. No index — the column is only ever read on a row
 * already loaded by primary key, never filtered on.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddContentTombstoneActor1793520000000 implements MigrationInterface {
  name = 'AddContentTombstoneActor1793520000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_posts" ADD "deleted_by_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_posts" ADD CONSTRAINT "FK_community_posts_deleted_by_id"
        FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(
      `ALTER TABLE "community_post_replies" ADD "deleted_by_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "community_post_replies" ADD CONSTRAINT "FK_community_post_replies_deleted_by_id"
        FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);

    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "deleted_by_id" uuid`,
    );
    await queryRunner.query(`
      ALTER TABLE "forum_post" ADD CONSTRAINT "FK_forum_post_deleted_by_id"
        FOREIGN KEY ("deleted_by_id") REFERENCES "users"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP CONSTRAINT "FK_forum_post_deleted_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "forum_post" DROP COLUMN "deleted_by_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP CONSTRAINT "FK_community_post_replies_deleted_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_post_replies" DROP COLUMN "deleted_by_id"`,
    );

    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP CONSTRAINT "FK_community_posts_deleted_by_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_posts" DROP COLUMN "deleted_by_id"`,
    );
  }
}
