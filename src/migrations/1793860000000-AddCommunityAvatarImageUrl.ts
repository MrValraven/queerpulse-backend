// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * A community's own avatar (`communities.avatar_image_url`), the small square
 * identity mark that appears in lists, nav and post bylines. Distinct from
 * `cover_image_url`, which is the wide banner on the detail page: cropping one
 * from the other gives a bad result in both directions.
 *
 * Same storage convention as `cover_image_url`, deliberately: the column holds
 * a RAW STORAGE KEY (or an absolute `https://` URL for an externally hosted
 * image), and `toImageUrl` resolves it to a fetchable `/files/*` URL at the
 * response boundary. Never write a resolved URL into this column. Resolved URLs
 * are signed and environment-specific, so a persisted one goes stale and cannot
 * be re-signed, and the row would then point at an image nobody can load.
 *
 * Nullable: most communities have no avatar and fall back to their generated
 * mark, so `ADD COLUMN` is metadata-only with nothing to backfill.
 */
export class AddCommunityAvatarImageUrl1793860000000 implements MigrationInterface {
  name = 'AddCommunityAvatarImageUrl1793860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" ADD "avatar_image_url" character varying`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "communities" DROP COLUMN "avatar_image_url"`,
    );
  }
}
