// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VJ v2: clip defaults (favorite, speed, loop points, loop mode) and the
 * animated preview key on `vj_clips`, the event link on `vj_packs`, and the
 * server-held scenes (`vj_scenes`), set lists (`vj_setlists`) and set list
 * steps (`vj_setlist_items`), managed by admins at `admin/vj`.
 *
 * Every `ADD COLUMN` has a constant default or none, so Postgres adds it
 * without a table rewrite. `vj_clips` holds at most 1000 rows and `vj_packs`
 * at most 50, so the CHECK and FK validation scans are instant; the FK on
 * `events` takes a brief lock while it validates an all-null column.
 *
 * Every CHECK mirrors a service check that runs first, so a violation never
 * reaches the driver with a scene name, set list name or look in its error
 * text. `created_by_user_id` is set null when its admin is erased and the
 * rows stay; the preview keys name nobody.
 *
 * The three new tables are empty, so every index builds inside the migration
 * transaction (plain `CREATE INDEX`). The migration inserts no rows and
 * creates no extension (`uuid-ossp` is already on).
 */
export class AddVjV21839500000000 implements MigrationInterface {
  name = 'AddVjV21839500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await this.addClipColumns(queryRunner);
    await this.addPackEventLink(queryRunner);
    await this.createScenes(queryRunner);
    await this.createSetlists(queryRunner);
    await this.createSetlistItems(queryRunner);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "vj_setlist_items"`);
    await queryRunner.query(`DROP TABLE "vj_setlists"`);
    await queryRunner.query(`DROP TABLE "vj_scenes"`);
    await queryRunner.query(`DROP INDEX "IDX_vj_packs_event_id"`);
    await queryRunner.query(
      `ALTER TABLE "vj_packs" DROP CONSTRAINT "FK_vj_packs_event"`,
    );
    await queryRunner.query(`ALTER TABLE "vj_packs" DROP COLUMN "event_id"`);
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP CONSTRAINT "CHK_vj_clips_preview_storage_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP CONSTRAINT "CHK_vj_clips_loop_points"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP CONSTRAINT "CHK_vj_clips_loop_mode"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP CONSTRAINT "CHK_vj_clips_default_speed"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP CONSTRAINT "UQ_vj_clips_preview_storage_key"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP COLUMN "preview_storage_key"`,
    );
    await queryRunner.query(`ALTER TABLE "vj_clips" DROP COLUMN "loop_mode"`);
    await queryRunner.query(`ALTER TABLE "vj_clips" DROP COLUMN "loop_out_ms"`);
    await queryRunner.query(`ALTER TABLE "vj_clips" DROP COLUMN "loop_in_ms"`);
    await queryRunner.query(
      `ALTER TABLE "vj_clips" DROP COLUMN "default_speed"`,
    );
    await queryRunner.query(`ALTER TABLE "vj_clips" DROP COLUMN "is_favorite"`);
  }

  /** The six clip columns, the preview key's unique constraint and the four clip CHECKs. */
  private async addClipColumns(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD "is_favorite" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD "default_speed" double precision NOT NULL DEFAULT 1`,
    );
    await queryRunner.query(`ALTER TABLE "vj_clips" ADD "loop_in_ms" integer`);
    await queryRunner.query(`ALTER TABLE "vj_clips" ADD "loop_out_ms" integer`);
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD "loop_mode" character varying(10) NOT NULL DEFAULT 'loop'`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD "preview_storage_key" character varying(200)`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD CONSTRAINT "UQ_vj_clips_preview_storage_key" UNIQUE ("preview_storage_key")`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD CONSTRAINT "CHK_vj_clips_default_speed" CHECK ("default_speed" IN (0.25, 0.5, 1, 1.5, 2, 4))`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD CONSTRAINT "CHK_vj_clips_loop_mode" CHECK ("loop_mode" IN ('loop', 'pingPong'))`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD CONSTRAINT "CHK_vj_clips_loop_points" CHECK (("loop_in_ms" IS NULL AND "loop_out_ms" IS NULL) OR ("media_kind" = 'video' AND ("loop_in_ms" IS NULL OR "loop_in_ms" >= 0) AND ("loop_out_ms" IS NULL OR "loop_out_ms" <= "duration_ms") AND COALESCE("loop_out_ms", "duration_ms") - COALESCE("loop_in_ms", 0) >= 250))`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_clips" ADD CONSTRAINT "CHK_vj_clips_preview_storage_key" CHECK ("preview_storage_key" IS NULL OR "preview_storage_key" LIKE 'vj-previews/%')`,
    );
  }

  /** `vj_packs.event_id`, its FK (set null when the event goes) and the partial index that backs it. */
  private async addPackEventLink(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "vj_packs" ADD "event_id" uuid`);
    await queryRunner.query(
      `ALTER TABLE "vj_packs" ADD CONSTRAINT "FK_vj_packs_event" FOREIGN KEY ("event_id") REFERENCES "events"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_packs_event_id" ON "vj_packs" ("event_id") WHERE "event_id" IS NOT NULL`,
    );
  }

  /** `vj_scenes` and its three indexes. */
  private async createScenes(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "vj_scenes" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "pack_id" uuid,
        "name" character varying(60) NOT NULL,
        "position" integer NOT NULL,
        "look" jsonb NOT NULL,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vj_scenes" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_vj_scenes_name" CHECK (char_length(btrim("name")) >= 1),
        CONSTRAINT "CHK_vj_scenes_position" CHECK ("position" >= 0),
        CONSTRAINT "CHK_vj_scenes_look" CHECK (jsonb_typeof("look") = 'object'),
        CONSTRAINT "FK_vj_scenes_pack" FOREIGN KEY ("pack_id") REFERENCES "vj_packs"("id") ON DELETE SET NULL ON UPDATE NO ACTION,
        CONSTRAINT "FK_vj_scenes_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_scenes_position" ON "vj_scenes" ("position", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_scenes_pack_id" ON "vj_scenes" ("pack_id") WHERE "pack_id" IS NOT NULL`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_scenes_created_by_user_id" ON "vj_scenes" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL`,
    );
  }

  /** `vj_setlists` and its two indexes. */
  private async createSetlists(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "vj_setlists" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "name" character varying(60) NOT NULL,
        "position" integer NOT NULL,
        "created_by_user_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_vj_setlists" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_vj_setlists_name" CHECK (char_length(btrim("name")) >= 1),
        CONSTRAINT "CHK_vj_setlists_position" CHECK ("position" >= 0),
        CONSTRAINT "FK_vj_setlists_created_by_user" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_setlists_position" ON "vj_setlists" ("position", "id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_setlists_created_by_user_id" ON "vj_setlists" ("created_by_user_id") WHERE "created_by_user_id" IS NOT NULL`,
    );
  }

  /** `vj_setlist_items` and its two indexes; both keys cascade on delete. */
  private async createSetlistItems(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "vj_setlist_items" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "setlist_id" uuid NOT NULL,
        "scene_id" uuid NOT NULL,
        "position" integer NOT NULL,
        CONSTRAINT "PK_vj_setlist_items" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_vj_setlist_items_position" CHECK ("position" >= 0),
        CONSTRAINT "FK_vj_setlist_items_setlist" FOREIGN KEY ("setlist_id") REFERENCES "vj_setlists"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_vj_setlist_items_scene" FOREIGN KEY ("scene_id") REFERENCES "vj_scenes"("id") ON DELETE CASCADE ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_setlist_items_setlist_position" ON "vj_setlist_items" ("setlist_id", "position")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_setlist_items_scene_id" ON "vj_setlist_items" ("scene_id")`,
    );
  }
}
