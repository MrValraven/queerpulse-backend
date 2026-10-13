// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v2: `studio_releases.followers_notified_at`, claimed once per
 * release by `StudioReleaseAlertsListener`, and the genre browse index.
 *
 * Releases already past draft when this runs were published before alerts
 * existed; marking them alerted keeps "first publish only" true for them, so
 * an unpublish and a republish of an old release stays quiet.
 *
 * `studio_releases` is a Studio v1 table that has not launched, so the index
 * builds inside the migration transaction.
 */
export class AddStudioReleaseFollowersNotifiedAt1831500100000 implements MigrationInterface {
  name = 'AddStudioReleaseFollowersNotifiedAt1831500100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD "followers_notified_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "studio_releases"
          SET "followers_notified_at" = COALESCE("published_at", "updated_at")
        WHERE "status" <> 'draft'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_genre_published_at" ON "studio_releases" ("genre", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_studio_releases_genre_published_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP COLUMN "followers_notified_at"`,
    );
  }
}
