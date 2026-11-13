// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * VJ sequences: a set list becomes a sequence of clip and scene steps that can
 * play itself. `vj_setlists` gains Loop (`is_looping`) and the default step
 * length (`step_duration_kind`, `step_duration_value`); `vj_setlist_items`
 * gains the step kind (`kind`), the clip target (`clip_id`) and an optional
 * own length (`duration_kind`, `duration_value`), and `scene_id` becomes
 * nullable because a clip step has no scene.
 *
 * Every `ADD COLUMN` has a constant default or none, so Postgres adds it
 * without a table rewrite. Existing rows become scene steps on the sequence
 * default length (both duration columns null), and every set list gets Loop
 * off and 8 seconds. `vj_setlists` and `vj_setlist_items` are small admin
 * tables, so the CHECK and FK validation scans are instant and the partial
 * index builds inside the migration transaction.
 *
 * `kind` pins exactly one target per kind through `CHK_vj_setlist_items_kind`.
 * `clip_id` cascades like `scene_id`: deleting a clip deletes its steps. The
 * partial index backs that FK action; `IDX_vj_setlist_items_scene_id` stays
 * as it is. Every CHECK mirrors a service check that runs first, so a
 * violation never reaches the driver with a set list name in its error text.
 *
 * `down()` deletes the clip steps and closes the position gaps before
 * `scene_id` turns `NOT NULL` again, so scene steps survive a rollback with
 * their order.
 */
export class AddVjSequences1840200000000 implements MigrationInterface {
  name = 'AddVjSequences1840200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" ADD "is_looping" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" ADD "step_duration_kind" character varying(10) NOT NULL DEFAULT 'seconds'`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" ADD "step_duration_value" integer NOT NULL DEFAULT 8`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" ADD CONSTRAINT "CHK_vj_setlists_step_duration" CHECK (("step_duration_kind" = 'seconds' AND "step_duration_value" BETWEEN 2 AND 600) OR ("step_duration_kind" = 'beats' AND "step_duration_value" IN (4, 8, 16, 32, 64)))`,
    );

    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD "kind" character varying(10) NOT NULL DEFAULT 'scene'`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD "clip_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD "duration_kind" character varying(10)`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD "duration_value" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ALTER COLUMN "scene_id" DROP NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD CONSTRAINT "FK_vj_setlist_items_clip" FOREIGN KEY ("clip_id") REFERENCES "vj_clips"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD CONSTRAINT "CHK_vj_setlist_items_kind" CHECK (("kind" = 'scene' AND "scene_id" IS NOT NULL AND "clip_id" IS NULL) OR ("kind" = 'clip' AND "clip_id" IS NOT NULL AND "scene_id" IS NULL))`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ADD CONSTRAINT "CHK_vj_setlist_items_duration" CHECK (("duration_kind" IS NULL AND "duration_value" IS NULL) OR ("duration_kind" = 'seconds' AND "duration_value" BETWEEN 2 AND 600) OR ("duration_kind" = 'beats' AND "duration_value" IN (4, 8, 16, 32, 64)))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_vj_setlist_items_clip_id" ON "vj_setlist_items" ("clip_id") WHERE "clip_id" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "IDX_vj_setlist_items_clip_id"`);
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP CONSTRAINT "CHK_vj_setlist_items_duration"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP CONSTRAINT "CHK_vj_setlist_items_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP CONSTRAINT "FK_vj_setlist_items_clip"`,
    );
    await queryRunner.query(
      `DELETE FROM "vj_setlist_items" WHERE "kind" = 'clip'`,
    );
    await queryRunner.query(
      `UPDATE "vj_setlist_items" AS "item" SET "position" = "ranked"."dense_position" FROM (SELECT "id", (ROW_NUMBER() OVER (PARTITION BY "setlist_id" ORDER BY "position", "id") - 1)::int AS "dense_position" FROM "vj_setlist_items") AS "ranked" WHERE "item"."id" = "ranked"."id" AND "item"."position" <> "ranked"."dense_position"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" ALTER COLUMN "scene_id" SET NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP COLUMN "duration_value"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP COLUMN "duration_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP COLUMN "clip_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlist_items" DROP COLUMN "kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" DROP CONSTRAINT "CHK_vj_setlists_step_duration"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" DROP COLUMN "step_duration_value"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" DROP COLUMN "step_duration_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "vj_setlists" DROP COLUMN "is_looping"`,
    );
  }
}
