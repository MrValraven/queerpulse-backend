// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the tables behind the Studio landing page v2 and the page column of the
 * landing visit counts.
 *
 * - `studio_landing_previews` holds tracks offered as public previews. A
 *   preview needs an owner's yes, and the public read drops it by the
 *   eligibility rules at request time. One open row (`pending` or `approved`)
 *   per track.
 * - `studio_landing_artist_cards` and `studio_landing_photos` store a staff
 *   consent tick that their check constraints enforce.
 * - `studio_founding_artists` outlives the shelf switch kept in the one-row
 *   `studio_landing_settings`.
 * - `studio_access_requests` holds members waiting for Studio access;
 *   `is_from_invite` marks the rows filed for an invite or a join request.
 * - `landing_visit_daily` gains `page`, with the existing rows read as `home`.
 *   The table still holds no IP, user agent, cookie, member id or time of day.
 */
export class AddStudioLandingV21838100000000 implements MigrationInterface {
  name = 'AddStudioLandingV21838100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_landing_previews_status_enum" AS ENUM ('pending', 'approved', 'declined', 'withdrawn')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_landing_photos_slot_enum" AS ENUM ('hero', 'manifesto')`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_landing_previews" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "track_id" uuid NOT NULL,
        "status" "studio_landing_previews_status_enum" NOT NULL DEFAULT 'pending',
        "position" smallint NOT NULL,
        "requested_by_id" uuid,
        "decided_by_id" uuid,
        "decided_at" TIMESTAMP(3) WITH TIME ZONE,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_landing_previews" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_landing_previews_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_landing_previews_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_landing_previews_requested_by" FOREIGN KEY ("requested_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_landing_previews_decided_by" FOREIGN KEY ("decided_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_landing_previews_open_track" ON "studio_landing_previews" ("track_id") WHERE "status" IN ('pending', 'approved')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_landing_previews_status_position" ON "studio_landing_previews" ("status", "position")`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_landing_artist_cards" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subprofile_id" uuid NOT NULL,
        "quote" character varying(240),
        "position" smallint NOT NULL,
        "has_consent" boolean NOT NULL,
        "consented_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "created_by_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_landing_artist_cards" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_landing_artist_cards_subprofile" UNIQUE ("subprofile_id"),
        CONSTRAINT "CHK_studio_landing_artist_cards_position" CHECK ("position" >= 1),
        CONSTRAINT "CHK_studio_landing_artist_cards_consent" CHECK ("has_consent"),
        CONSTRAINT "FK_studio_landing_artist_cards_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_landing_artist_cards_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "studio_landing_photos" (
        "slot" "studio_landing_photos_slot_enum" NOT NULL,
        "image_key" character varying NOT NULL,
        "alt_text_en" character varying(200) NOT NULL,
        "alt_text_pt" character varying(200) NOT NULL,
        "credit" character varying(120),
        "has_consent" boolean NOT NULL,
        "consented_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_by_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_landing_photos" PRIMARY KEY ("slot"),
        CONSTRAINT "CHK_studio_landing_photos_consent" CHECK ("has_consent"),
        CONSTRAINT "FK_studio_landing_photos_updated_by" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "studio_founding_artists" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "subprofile_id" uuid NOT NULL,
        "position" smallint NOT NULL,
        "added_by_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_founding_artists" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_founding_artists_subprofile" UNIQUE ("subprofile_id"),
        CONSTRAINT "CHK_studio_founding_artists_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_founding_artists_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_founding_artists_added_by" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "studio_landing_settings" (
        "id" smallint NOT NULL DEFAULT 1,
        "is_founding_shelf_visible" boolean NOT NULL DEFAULT true,
        "updated_by_id" uuid,
        "updated_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_landing_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_landing_settings_single_row" CHECK ("id" = 1),
        CONSTRAINT "FK_studio_landing_settings_updated_by" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `INSERT INTO "studio_landing_settings" ("id", "is_founding_shelf_visible") VALUES (1, true)`,
    );

    await queryRunner.query(`
      CREATE TABLE "studio_access_requests" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "user_id" uuid NOT NULL,
        "wants_to_release" boolean NOT NULL DEFAULT false,
        "is_from_invite" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_access_requests" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_access_requests_user" UNIQUE ("user_id"),
        CONSTRAINT "FK_studio_access_requests_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_access_requests_queue" ON "studio_access_requests" ("wants_to_release" DESC, "created_at" ASC, "id" ASC)`,
    );

    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" ADD COLUMN "page" varchar(16) NOT NULL DEFAULT 'home'`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" ADD CONSTRAINT "CHK_landing_visit_daily_page" CHECK ("page" IN ('home', 'studio'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" DROP CONSTRAINT "PK_landing_visit_daily"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" ADD CONSTRAINT "PK_landing_visit_daily" PRIMARY KEY ("day", "page", "source")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "landing_visit_daily" WHERE "page" = 'studio'`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" DROP CONSTRAINT "PK_landing_visit_daily"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" ADD CONSTRAINT "PK_landing_visit_daily" PRIMARY KEY ("day", "source")`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" DROP CONSTRAINT "CHK_landing_visit_daily_page"`,
    );
    await queryRunner.query(
      `ALTER TABLE "landing_visit_daily" DROP COLUMN "page"`,
    );

    await queryRunner.query(`DROP TABLE "studio_access_requests"`);
    await queryRunner.query(`DROP TABLE "studio_landing_settings"`);
    await queryRunner.query(`DROP TABLE "studio_founding_artists"`);
    await queryRunner.query(`DROP TABLE "studio_landing_photos"`);
    await queryRunner.query(`DROP TABLE "studio_landing_artist_cards"`);
    await queryRunner.query(`DROP TABLE "studio_landing_previews"`);

    await queryRunner.query(`DROP TYPE "studio_landing_photos_slot_enum"`);
    await queryRunner.query(`DROP TYPE "studio_landing_previews_status_enum"`);
  }
}
