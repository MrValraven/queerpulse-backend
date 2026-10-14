// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v3 artist tools (`QUEERPULSE-STUDIO-V3-ARTIST-TOOLS-DESIGN-2026-10-13.md`):
 *
 * - `studio_releases` gains `publish_at` (a scheduled drop), `tracks_changed_at`
 *   (track edits on a live release), `preview_token` and
 *   `preview_link_created_at` (private preview links) and `buy_url`.
 *   `CHK_studio_releases_publish_at` ties `publish_at` to the `scheduled`
 *   status both ways, so a takedown or the drop has to clear it.
 * - `studio_release_reminders` ("Notify me") and `studio_release_versions`
 *   (version notes), each cascading with its release on delete and on
 *   update (an unlink gives releases fresh ids).
 * - `studio_press_kits`, one row per persona.
 * - `subprofile_posts` (persona posts) and `subprofile_post_quota_entries`
 *   (the 24 hour ledger behind the post limit and the alert throttle).
 *
 * Every foreign key to `subprofiles` cascades on update, for the unlink
 * re-key (`src/subprofiles/persona-foreign-keys.spec.ts`). The new tables are
 * empty and `studio_releases` belongs to the unlaunched Studio, so every
 * index builds inside the migration transaction. Runs after
 * `AddStudioArtistToolsEnumValues1832000000000`, which commits the
 * `scheduled` label this file's CHECK and index use.
 */
export class AddStudioArtistTools1832000100000 implements MigrationInterface {
  name = 'AddStudioArtistTools1832000100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "studio_releases"
        ADD "publish_at" TIMESTAMP(3) WITH TIME ZONE,
        ADD "tracks_changed_at" TIMESTAMP(3) WITH TIME ZONE,
        ADD "preview_token" character varying(64),
        ADD "preview_link_created_at" TIMESTAMP WITH TIME ZONE,
        ADD "buy_url" character varying(1000)
    `);
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD CONSTRAINT "CHK_studio_releases_publish_at" CHECK (("status" = 'scheduled') = ("publish_at" IS NOT NULL))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_publish_at" ON "studio_releases" ("publish_at") WHERE "status" = 'scheduled'`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_releases_preview_token" ON "studio_releases" ("preview_token") WHERE "preview_token" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_release_reminders" (
        "release_id" uuid NOT NULL,
        "user_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_release_reminders" PRIMARY KEY ("release_id", "user_id"),
        CONSTRAINT "FK_studio_release_reminders_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_release_reminders_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_release_reminders_user_id" ON "studio_release_reminders" ("user_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_release_versions" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "release_id" uuid NOT NULL,
        "version" smallint NOT NULL,
        "note" character varying(280) NOT NULL,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_release_versions" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_release_versions_release_version" UNIQUE ("release_id", "version"),
        CONSTRAINT "CHK_studio_release_versions_version" CHECK ("version" >= 2),
        CONSTRAINT "CHK_studio_release_versions_note" CHECK (btrim("note") <> ''),
        CONSTRAINT "FK_studio_release_versions_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "studio_press_kits" (
        "subprofile_id" uuid NOT NULL,
        "pitch" character varying(140),
        "press_bio" text,
        "featured_track_ids" uuid array NOT NULL DEFAULT '{}',
        "quotes" jsonb NOT NULL DEFAULT '[]',
        "contact" character varying(1000),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_press_kits" PRIMARY KEY ("subprofile_id"),
        CONSTRAINT "CHK_studio_press_kits_featured_track_ids" CHECK (cardinality("featured_track_ids") <= 5),
        CONSTRAINT "CHK_studio_press_kits_press_bio" CHECK ("press_bio" IS NULL OR char_length("press_bio") <= 1500),
        CONSTRAINT "FK_studio_press_kits_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(`
      CREATE TABLE "subprofile_posts" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "author_user_id" uuid,
        "body" character varying(500) NOT NULL,
        "link_url" character varying(1000),
        "image_key" character varying,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        "edited_at" TIMESTAMP WITH TIME ZONE,
        CONSTRAINT "PK_subprofile_posts" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_subprofile_posts_body" CHECK (btrim("body") <> ''),
        CONSTRAINT "FK_subprofile_posts_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_subprofile_posts_author" FOREIGN KEY ("author_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_posts_subprofile_created_at" ON "subprofile_posts" ("subprofile_id", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_posts_author_user_id" ON "subprofile_posts" ("author_user_id") WHERE "author_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_posts_image_key" ON "subprofile_posts" ("image_key") WHERE "image_key" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "subprofile_post_quota_entries" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_subprofile_post_quota_entries" PRIMARY KEY ("id"),
        CONSTRAINT "FK_subprofile_post_quota_entries_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_subprofile_post_quota_entries_subprofile_created_at" ON "subprofile_post_quota_entries" ("subprofile_id", "created_at")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "subprofile_post_quota_entries"`);
    await queryRunner.query(`DROP TABLE "subprofile_posts"`);
    await queryRunner.query(`DROP TABLE "studio_press_kits"`);
    await queryRunner.query(`DROP TABLE "studio_release_versions"`);
    await queryRunner.query(`DROP TABLE "studio_release_reminders"`);
    await queryRunner.query(`DROP INDEX "UQ_studio_releases_preview_token"`);
    await queryRunner.query(`DROP INDEX "IDX_studio_releases_publish_at"`);
    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP CONSTRAINT "CHK_studio_releases_publish_at"`,
    );
    // The `scheduled` label outlives this migration (enum labels cannot be
    // dropped), so a scheduled row goes back to draft before its time goes.
    await queryRunner.query(
      `UPDATE "studio_releases" SET "status" = 'draft' WHERE "status" = 'scheduled'`,
    );
    await queryRunner.query(`
      ALTER TABLE "studio_releases"
        DROP COLUMN "buy_url",
        DROP COLUMN "preview_link_created_at",
        DROP COLUMN "preview_token",
        DROP COLUMN "tracks_changed_at",
        DROP COLUMN "publish_at"
    `);
  }
}
