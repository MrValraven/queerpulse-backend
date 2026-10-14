// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio open demo pages (`QUEERPULSE-STUDIO-OPEN-DEMO-PAGES-DESIGN-2026-10-13.md`,
 * section 6.1): the Studio player's three settings on `member_preferences`,
 * read and written through `GET/PUT /me/studio-playback`.
 *
 * Every default is a literal and matches `PreferencesService.defaults()`, so
 * a member with no row and a member with an untouched row read the same:
 * autoplay next on, explicit tracks shown, crossfade off. Plain additive
 * columns on an existing table, no backfill and no index; the CHECK is its
 * own statement so `down()` drops it before the column it constrains.
 * Nothing here records what anyone plays.
 */
export class AddStudioPlaybackPreferences1831700000000 implements MigrationInterface {
  name = 'AddStudioPlaybackPreferences1831700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD COLUMN "studio_autoplay_next" boolean NOT NULL DEFAULT true,
        ADD COLUMN "studio_hide_explicit" boolean NOT NULL DEFAULT false,
        ADD COLUMN "studio_crossfade_seconds" smallint NOT NULL DEFAULT 0
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD CONSTRAINT "CHK_member_preferences_studio_crossfade_seconds"
        CHECK ("studio_crossfade_seconds" BETWEEN 0 AND 12)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP CONSTRAINT "CHK_member_preferences_studio_crossfade_seconds"
    `);
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP COLUMN "studio_autoplay_next",
        DROP COLUMN "studio_hide_explicit",
        DROP COLUMN "studio_crossfade_seconds"
    `);
  }
}
