// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VJ: the shared clip library (`vj_clips`), its ordered packs (`vj_packs`)
 * and pack membership (`vj_pack_clips`), managed by admins at `admin/vj`.
 *
 * Every CHECK mirrors a service check that runs first, so a violation never
 * reaches the driver with a clip title or pack name in its error text.
 * `created_by_user_id` is set null when its admin is erased, and the storage
 * keys name nobody, so erasure keeps the library. Deleting a pack or a clip
 * cascades its memberships.
 *
 * All three tables are new and empty, so every index builds inside the
 * migration transaction (plain `CREATE INDEX`). The migration inserts no rows
 * and creates no extension (`uuid-ossp` is already on).
 */
export class AddVj1839400000000 implements MigrationInterface {
  name = 'AddVj1839400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "vj_clips" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "title" character varying(120) NOT NULL,
        "media_kind" character varying(10) NOT NULL,
        "mime_type" character varying(20) NOT NULL,
        "byte_size" integer NOT NULL,
        "width" integer NOT NULL,
        "height" integer NOT NULL,
        "duration_ms" integer,
        "storage_key" character varying(200) NOT NULL,
        "thumbnail_storage_key" character varying(200) NOT NULL,
        "fit_mode" character varying(10) NOT NULL DEFAULT 'fill',
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vj_clips" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_vj_clips_storage_key" UNIQUE ("storage_key"),
        CONSTRAINT "UQ_vj_clips_thumbnail_storage_key" UNIQUE ("thumbnail_storage_key"),
        CONSTRAINT "CHK_vj_clips_title" CHECK (char_length(btrim("title")) >= 1),
        CONSTRAINT "CHK_vj_clips_media_kind" CHECK ("media_kind" IN ('video', 'gif')),
        CONSTRAINT "CHK_vj_clips_mime_type" CHECK ("mime_type" IN ('video/mp4', 'video/webm', 'image/gif')),
        CONSTRAINT "CHK_vj_clips_kind_matches_type" CHECK (("media_kind" = 'gif') = ("mime_type" = 'image/gif')),
        CONSTRAINT "CHK_vj_clips_byte_size" CHECK ("byte_size" BETWEEN 1 AND 104857600),
        CONSTRAINT "CHK_vj_clips_dimensions" CHECK ("width" BETWEEN 1 AND 16384 AND "height" BETWEEN 1 AND 16384),
        CONSTRAINT "CHK_vj_clips_duration" CHECK (CASE WHEN "media_kind" = 'video' THEN ("duration_ms" IS NOT NULL AND "duration_ms" BETWEEN 1 AND 3600000) ELSE "duration_ms" IS NULL END),
        CONSTRAINT "CHK_vj_clips_fit_mode" CHECK ("fit_mode" IN ('fill', 'fit')),
        CONSTRAINT "CHK_vj_clips_storage_key" CHECK ("storage_key" LIKE 'vj-clips/%'),
        CONSTRAINT "CHK_vj_clips_thumbnail_storage_key" CHECK ("thumbnail_storage_key" LIKE 'vj-thumbnails/%'),
        CONSTRAINT "FK_vj_clips_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_clips_created_at" ON "vj_clips" ("created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_clips_created_by_user_id" ON "vj_clips" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "vj_packs" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(60) NOT NULL,
        "position" integer NOT NULL,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vj_packs" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_vj_packs_name" CHECK (char_length(btrim("name")) >= 1),
        CONSTRAINT "CHK_vj_packs_position" CHECK ("position" >= 0),
        CONSTRAINT "FK_vj_packs_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_packs_position" ON "vj_packs" ("position", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_packs_created_by_user_id" ON "vj_packs" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE TABLE "vj_pack_clips" (
        "pack_id" uuid NOT NULL,
        "clip_id" uuid NOT NULL,
        "position" integer NOT NULL,
        "added_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vj_pack_clips" PRIMARY KEY ("pack_id", "clip_id"),
        CONSTRAINT "CHK_vj_pack_clips_position" CHECK ("position" >= 0),
        CONSTRAINT "FK_vj_pack_clips_pack" FOREIGN KEY ("pack_id") REFERENCES "vj_packs"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_vj_pack_clips_clip" FOREIGN KEY ("clip_id") REFERENCES "vj_clips"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_pack_clips_pack_position" ON "vj_pack_clips" ("pack_id", "position")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_pack_clips_clip_id" ON "vj_pack_clips" ("clip_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vj_pack_clips"`);
    await queryRunner.query(`DROP TABLE "vj_packs"`);
    await queryRunner.query(`DROP TABLE "vj_clips"`);
  }
}
