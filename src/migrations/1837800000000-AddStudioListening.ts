// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the Studio listening tables and the two preference columns behind them.
 *
 * - `studio_track_play_daily` holds one row per track and UTC day with the play
 *   count. It carries no member, so the totals survive a cleared history and
 *   a deleted account.
 * - `studio_listens` is a member's own listening history. Only that member
 *   reads it, and a scheduled job prunes rows after 13 months. The history
 *   index orders by `played_at` then `id`, both descending, for keyset paging.
 * - `studio_supporters` holds opt-ins: a member who chose to show as a
 *   supporter of one artist persona, as their account or as another persona.
 * - `member_preferences` gains `is_listening_history_on` (on by default) and
 *   `listening_notice_seen_at` (the first time the member saw the notice).
 *
 * The partial milestone index on `track_id` serves the track delete cascade,
 * which the milestones migration deferred.
 */
export class AddStudioListening1837800000000 implements MigrationInterface {
  name = 'AddStudioListening1837800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD COLUMN "is_listening_history_on" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" ADD COLUMN "listening_notice_seen_at" TIMESTAMP WITH TIME ZONE`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_track_play_daily" (
        "track_id" uuid NOT NULL,
        "day" date NOT NULL,
        "plays" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_studio_track_play_daily" PRIMARY KEY ("track_id", "day"),
        CONSTRAINT "FK_studio_track_play_daily_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "studio_listens" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "track_id" uuid NOT NULL,
        "played_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_listens" PRIMARY KEY ("id"),
        CONSTRAINT "FK_studio_listens_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_listens_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_listens_user_played_at" ON "studio_listens" ("user_id", "played_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_listens_track_played_at" ON "studio_listens" ("track_id", "played_at")`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_supporters" (
        "user_id" uuid NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "shown_as_subprofile_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_supporters" PRIMARY KEY ("user_id", "subprofile_id"),
        CONSTRAINT "CHK_studio_supporters_shown_as_other" CHECK ("shown_as_subprofile_id" IS NULL OR "shown_as_subprofile_id" <> "subprofile_id"),
        CONSTRAINT "FK_studio_supporters_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_supporters_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_supporters_shown_as_subprofile" FOREIGN KEY ("shown_as_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_supporters_subprofile" ON "studio_supporters" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_supporters_shown_as" ON "studio_supporters" ("shown_as_subprofile_id") WHERE "shown_as_subprofile_id" IS NOT NULL`,
    );

    await queryRunner.query(
      `CREATE INDEX "IDX_studio_artist_milestones_track" ON "studio_artist_milestones" ("track_id") WHERE "track_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_studio_artist_milestones_track"`);
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "listening_notice_seen_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "member_preferences" DROP COLUMN "is_listening_history_on"`,
    );
    await queryRunner.query(`DROP TABLE "studio_supporters"`);
    await queryRunner.query(`DROP TABLE "studio_listens"`);
    await queryRunner.query(`DROP TABLE "studio_track_play_daily"`);
  }
}
