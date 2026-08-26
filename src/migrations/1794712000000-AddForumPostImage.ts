// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `forum_post.image`: one optional photo attached to a forum post (SOC-13).
 *
 * The forum composer was a plain textarea, so half the practical questions the
 * forum exists for ("is this rash the thing the clinic warned me about", "which
 * of these two forms is the right one", "here is the letter my landlord sent")
 * could not be asked at all. Community posts have carried
 * `community_posts.image` since they shipped; this is the same column, the same
 * presigned upload pipeline, and the same `@IsImageReference` validation on the
 * write DTOs.
 *
 * Stores a bare storage key (`<prefix>/<ownerUserId>/<uuid><ext>`), never a
 * URL: `StorageKeyOwnershipInterceptor` normalises any `/files/<key>` form back
 * to the bare key on the way in and refuses a key the caller does not own, and
 * `toImageUrl` resolves it back to a fetchable `GET /files/*` URL on the way
 * out. `character varying` with no length cap matches `community_posts.image`.
 *
 * Nullable with no default: an ordinary text post has no photo, and a NULL is
 * exactly "no image" with nothing to backfill.
 *
 * No index. The column is only ever read on a row already loaded by primary key
 * or by the thread's post page, never filtered or sorted on.
 */
export class AddForumPostImage1794712000000 implements MigrationInterface {
  name = 'AddForumPostImage1794712000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_post" ADD "image" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "forum_post" DROP COLUMN "image"`);
  }
}
