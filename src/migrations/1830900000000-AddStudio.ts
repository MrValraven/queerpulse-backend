// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Studio v1 (`QUEERPULSE-STUDIO-V1-DESIGN-2026-10-08.md`, section 3): access
 * grants, releases, tracks and the registry of Studio audio keys.
 *
 * Every foreign key to `subprofiles` cascades on update, because an unlink
 * gives the persona a fresh id (`issueFreshPersonaId`), and on delete, so a
 * deleted persona takes its releases, tracks and audio rows along.
 * `studio_tracks.release_id` cascades on update for the same unlink, which
 * also gives every release a fresh id.
 *
 * `UQ_studio_tracks_release_position` is DEFERRABLE INITIALLY IMMEDIATE: a
 * reorder or a delete rewrites positions in one statement and Postgres checks
 * uniqueness at the statement's end. The home feed reads
 * `IDX_studio_releases_status_published_at` in its own order.
 *
 * All four tables are new and empty, so every index builds inside the
 * migration transaction.
 */
export class AddStudio1830900000000 implements MigrationInterface {
  name = 'AddStudio1830900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_releases_type_enum" AS ENUM ('album', 'ep', 'single', 'mix')`,
    );
    await queryRunner.query(
      `CREATE TYPE "studio_releases_status_enum" AS ENUM ('draft', 'published', 'taken_down')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_access_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "granted_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_access_grants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_studio_access_grants_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_studio_access_grants_granted_by" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_access_grants_user_id" ON "studio_access_grants" ("user_id")`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_releases" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "title" character varying(120) NOT NULL,
        "type" "studio_releases_type_enum" NOT NULL,
        "description" text,
        "genre" character varying(40),
        "cover_key" character varying,
        "released_on" date,
        "status" "studio_releases_status_enum" NOT NULL DEFAULT 'draft',
        "published_at" TIMESTAMP(3) WITH TIME ZONE,
        "rights_confirmed_at" TIMESTAMP WITH TIME ZONE,
        "taken_down_at" TIMESTAMP WITH TIME ZONE,
        "taken_down_by_id" uuid,
        "takedown_reason" character varying(500),
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_releases" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_studio_releases_published_at" CHECK ("status" <> 'published' OR "published_at" IS NOT NULL),
        CONSTRAINT "FK_studio_releases_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_releases_taken_down_by" FOREIGN KEY ("taken_down_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_status_published_at" ON "studio_releases" ("status", "published_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_subprofile_status" ON "studio_releases" ("subprofile_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_releases_cover_key" ON "studio_releases" ("cover_key") WHERE "cover_key" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_tracks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "release_id" uuid NOT NULL,
        "position" smallint NOT NULL,
        "title" character varying(120) NOT NULL,
        "audio_key" character varying,
        "audio_content_type" character varying(20),
        "audio_bytes" integer,
        "duration_seconds" integer,
        "credits" jsonb NOT NULL DEFAULT '[]',
        "lyrics" text,
        "is_explicit" boolean NOT NULL DEFAULT false,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_tracks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_tracks_release_position" UNIQUE ("release_id", "position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "CHK_studio_tracks_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_tracks_release" FOREIGN KEY ("release_id") REFERENCES "studio_releases"("id") ON DELETE CASCADE ON UPDATE CASCADE
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_studio_tracks_audio_key" ON "studio_tracks" ("audio_key") WHERE "audio_key" IS NOT NULL`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_audio_uploads" (
        "storage_key" character varying NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "uploaded_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_audio_uploads" PRIMARY KEY ("storage_key"),
        CONSTRAINT "FK_studio_audio_uploads_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_audio_uploads_uploaded_by" FOREIGN KEY ("uploaded_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_audio_uploads_subprofile_id" ON "studio_audio_uploads" ("subprofile_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_audio_uploads_uploaded_by_id" ON "studio_audio_uploads" ("uploaded_by_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_audio_uploads"`);
    await queryRunner.query(`DROP TABLE "studio_tracks"`);
    await queryRunner.query(`DROP TABLE "studio_releases"`);
    await queryRunner.query(`DROP TABLE "studio_access_grants"`);
    await queryRunner.query(`DROP TYPE "studio_releases_status_enum"`);
    await queryRunner.query(`DROP TYPE "studio_releases_type_enum"`);
  }
}
