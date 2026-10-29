// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio welcome, once per account: the welcome flow's seen stamp and the
 * taste picks (genres and moods) move from the browser's localStorage to
 * `member_preferences`, read and written through `GET/PUT /me/studio-welcome`.
 * A member who finished the welcome on a phone no longer sees it again on a
 * computer.
 *
 * - `studio_welcome_seen_at timestamptz NULL`: null until the welcome is
 *   finished, stamped once and never moved.
 * - `studio_taste_genres text[] NOT NULL DEFAULT '{}'` and
 *   `studio_taste_moods text[] NOT NULL DEFAULT '{}'`: the picked ids from
 *   `STUDIO_GENRES` and `STUDIO_MOODS`, validated in the DTO.
 *
 * Every default is a literal and matches `PreferencesService.defaults()`, so a
 * member with no row and a member with an untouched row read the same. Plain
 * additive columns on an existing table, no backfill and no index.
 */
export class AddStudioWelcome1838000300000 implements MigrationInterface {
  name = 'AddStudioWelcome1838000300000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        ADD COLUMN "studio_welcome_seen_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "studio_taste_genres" text array NOT NULL DEFAULT '{}',
        ADD COLUMN "studio_taste_moods" text array NOT NULL DEFAULT '{}'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "member_preferences"
        DROP COLUMN "studio_taste_moods",
        DROP COLUMN "studio_taste_genres",
        DROP COLUMN "studio_welcome_seen_at"
    `);
  }
}
