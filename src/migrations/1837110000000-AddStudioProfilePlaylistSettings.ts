// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio profile playlists: `studio_profile_playlist_settings` holds, per
 * member, whether their playlists appear on their public profile
 * (`is_shown`, default true) and the ordered playlists they feature
 * (`featured_ids`, at most 12, default empty). The row is created on the
 * first save, so existing members keep today's behaviour. The account
 * cascades. The table is new and empty and the primary key is the only
 * lookup, so no extra index is needed.
 */
export class AddStudioProfilePlaylistSettings1837110000000 implements MigrationInterface {
  name = 'AddStudioProfilePlaylistSettings1837110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "studio_profile_playlist_settings" (
        "user_id" uuid NOT NULL,
        "is_shown" boolean NOT NULL DEFAULT true,
        "featured_ids" uuid array NOT NULL DEFAULT '{}',
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_profile_playlist_settings" PRIMARY KEY ("user_id"),
        CONSTRAINT "CHK_studio_profile_playlist_settings_featured_max" CHECK (cardinality("featured_ids") <= 12),
        CONSTRAINT "FK_studio_profile_playlist_settings_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_profile_playlist_settings"`);
  }
}
