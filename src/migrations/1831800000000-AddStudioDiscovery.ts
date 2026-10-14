// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio discovery (`QUEERPULSE-STUDIO-DISCOVERY-DESIGN-2026-10-13.md`):
 * staff shelves, scenes and their pinned events, persona credits, and a mood
 * and a scene on each release.
 *
 * Both subprofile foreign keys of `studio_persona_credits` cascade on update,
 * so the unlink re-key (`issueFreshPersonaId`) can move the persona row; the
 * unlink hook then deletes every credit touching the persona in the same
 * transaction. `FK_studio_persona_credits_track` and
 * `FK_studio_curated_picks_release` cascade on update for the same re-key,
 * which gives the persona's releases and tracks fresh ids too.
 *
 * `UQ_studio_curated_picks_shelf_position` is DEFERRABLE INITIALLY
 * IMMEDIATE: a reorder rewrites every position of a shelf in one statement
 * under `SET CONSTRAINTS ... DEFERRED`, and a remove closes the gap in one
 * statement.
 *
 * Every new table is empty and `studio_releases` belongs to the unlaunched
 * Studio, so every index builds inside the migration transaction. The two
 * notification labels come in `AddStudioCreditNotificationTypes1831800100000`,
 * outside a transaction.
 */
export class AddStudioDiscovery1831800000000 implements MigrationInterface {
  name = 'AddStudioDiscovery1831800000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_curated_picks_shelf_enum" AS ENUM ('featured', 'staff_picks', 'new_this_week')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_scenes_status_enum" AS ENUM ('active', 'archived')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_persona_credits_status_enum" AS ENUM ('pending', 'accepted', 'declined')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_scenes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "slug" character varying(60) NOT NULL,
        "name" character varying(60) NOT NULL,
        "city" character varying(60) NOT NULL,
        "blurb" text,
        "cover_key" character varying,
        "status" "studio_scenes_status_enum" NOT NULL DEFAULT 'active',
        "position" smallint NOT NULL,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_scenes" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_scenes_slug" UNIQUE ("slug"),
        CONSTRAINT "FK_studio_scenes_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_scenes_status_position" ON "studio_scenes" ("status", "position")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_curated_picks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "shelf" "studio_curated_picks_shelf_enum" NOT NULL,
        "release_id" uuid NOT NULL,
        "note" character varying(140),
        "position" smallint NOT NULL,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_curated_picks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_curated_picks_shelf_release" UNIQUE ("shelf", "release_id"),
        CONSTRAINT "UQ_studio_curated_picks_shelf_position" UNIQUE ("shelf", "position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "CHK_studio_curated_picks_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_curated_picks_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_curated_picks_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_curated_picks_release_id" ON "studio_curated_picks" ("release_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_scene_events" (
        "scene_id" uuid NOT NULL,
        "event_id" uuid NOT NULL,
        "pinned_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_scene_events" PRIMARY KEY ("scene_id", "event_id"),
        CONSTRAINT "FK_studio_scene_events_scene" FOREIGN KEY ("scene_id") REFERENCES "studio_scenes"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_scene_events_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_scene_events_pinned_by" FOREIGN KEY ("pinned_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_scene_events_event_id" ON "studio_scene_events" ("event_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_persona_credits" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "track_id" uuid NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "role" character varying(20) NOT NULL,
        "status" "studio_persona_credits_status_enum" NOT NULL DEFAULT 'pending',
        "requested_by_subprofile_id" uuid NOT NULL,
        "requested_by_user_id" uuid,
        "responded_at" TIMESTAMP WITH TIME ZONE,
        "requester_dismissed_at" TIMESTAMP WITH TIME ZONE,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_persona_credits" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_persona_credits_track_subprofile_role" UNIQUE ("track_id", "subprofile_id", "role"),
        CONSTRAINT "FK_studio_persona_credits_track" FOREIGN KEY ("track_id") REFERENCES "studio_tracks"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_persona_credits_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_persona_credits_requested_by_subprofile" FOREIGN KEY ("requested_by_subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_persona_credits_requested_by_user" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_persona_credits_subprofile_status" ON "studio_persona_credits" ("subprofile_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_persona_credits_track_id" ON "studio_persona_credits" ("track_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_persona_credits_requested_by_subprofile_id" ON "studio_persona_credits" ("requested_by_subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_persona_credits_requested_by_user_id" ON "studio_persona_credits" ("requested_by_user_id")`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD "mood" character varying(40), ADD "scene_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_releases" ADD CONSTRAINT "FK_studio_releases_scene" FOREIGN KEY ("scene_id") REFERENCES "studio_scenes"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_mood_published_at" ON "studio_releases" ("mood", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_scene_published_at" ON "studio_releases" ("scene_id", "published_at" DESC, "id" DESC) WHERE "status" = 'published'`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_studio_releases_scene_published_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "IDX_studio_releases_mood_published_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP CONSTRAINT "FK_studio_releases_scene"`,
    );
    await queryRunner.query(
      `ALTER TABLE "studio_releases" DROP COLUMN "scene_id"`,
    );
    await queryRunner.query(`ALTER TABLE "studio_releases" DROP COLUMN "mood"`);
    await queryRunner.query(
      `DROP INDEX "IDX_studio_persona_credits_requested_by_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "studio_persona_credits"`);
    await queryRunner.query(`DROP TABLE "studio_scene_events"`);
    await queryRunner.query(`DROP TABLE "studio_curated_picks"`);
    await queryRunner.query(`DROP TABLE "studio_scenes"`);
    await queryRunner.query(`DROP TYPE "studio_persona_credits_status_enum"`);
    await queryRunner.query(`DROP TYPE "studio_scenes_status_enum"`);
    await queryRunner.query(`DROP TYPE "studio_curated_picks_shelf_enum"`);
  }
}
