// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `studio_spotlight_artists`, the persona placements behind the two
 * Studio home spotlight sections, Artist of the month and New stars. One row
 * is one persona in one slot. `(slot, position)` is deferrable so a reorder
 * writes in one statement, and the persona key cascades on delete and on
 * update so an unlink re-key succeeds. The user runs this migration.
 */
export class AddStudioSpotlightArtists1838300000000 implements MigrationInterface {
  name = 'AddStudioSpotlightArtists1838300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "studio_spotlight_slot" AS ENUM ('artist_of_the_month', 'new_stars')`,
    );
    await queryRunner.query(`
      CREATE TABLE "studio_spotlight_artists" (
        "id" uuid NOT NULL DEFAULT gen_random_uuid(),
        "slot" "studio_spotlight_slot" NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "position" smallint NOT NULL,
        "note" character varying(140),
        "created_by_id" uuid,
        "created_at" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_studio_spotlight_artists" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_studio_spotlight_artists_slot_subprofile" UNIQUE ("slot", "subprofile_id"),
        CONSTRAINT "UQ_studio_spotlight_artists_slot_position" UNIQUE ("slot", "position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "CHK_studio_spotlight_artists_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_studio_spotlight_artists_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_studio_spotlight_artists_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE INDEX "IDX_studio_spotlight_artists_subprofile_id" ON "studio_spotlight_artists" ("subprofile_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "studio_spotlight_artists"`);
    await queryRunner.query(`DROP TYPE "studio_spotlight_slot"`);
  }
}
