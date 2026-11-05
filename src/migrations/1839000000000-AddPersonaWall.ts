// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Persona wall: the personas an admin hand-picked for the wall on the People
 * Directory hero, at most 9, in a chosen order, plus a single settings row
 * for the fill order of the rest.
 *
 * `UQ_persona_wall_picks_position` is DEFERRABLE INITIALLY IMMEDIATE: a
 * reorder rewrites every position in one statement under
 * `SET CONSTRAINTS ... DEFERRED`, and a remove closes the gap in one
 * statement. The unique on `subprofile_id` doubles as its index. The key to
 * `subprofiles` cascades on update too, because an unlink re-keys the persona.
 *
 * Both tables are new and empty, so they build inside the migration
 * transaction. No extra index is added: `IDX_subprofile_endorsements_subprofile_id`
 * serves the endorsed fill. The statements carry no `IF NOT EXISTS` guards and
 * no row is inserted.
 */
export class AddPersonaWall1839000000000 implements MigrationInterface {
  name = 'AddPersonaWall1839000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "persona_wall_picks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "subprofile_id" uuid NOT NULL,
        "position" smallint NOT NULL,
        "added_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_persona_wall_picks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_persona_wall_picks_subprofile" UNIQUE ("subprofile_id"),
        CONSTRAINT "UQ_persona_wall_picks_position" UNIQUE ("position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "CHK_persona_wall_picks_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_persona_wall_picks_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_persona_wall_picks_added_by" FOREIGN KEY ("added_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
    await queryRunner.query(
      `CREATE TABLE "persona_wall_settings" (
        "id" smallint NOT NULL,
        "fill_order" character varying(20) NOT NULL DEFAULT 'endorsed',
        "updated_by_id" uuid,
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_persona_wall_settings" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_persona_wall_settings_singleton" CHECK ("id" = 1),
        CONSTRAINT "CHK_persona_wall_settings_fill_order" CHECK ("fill_order" IN ('endorsed', 'followed', 'newest', 'daily_shuffle')),
        CONSTRAINT "FK_persona_wall_settings_updated_by" FOREIGN KEY ("updated_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "persona_wall_settings"`);
    await queryRunner.query(`DROP TABLE "persona_wall_picks"`);
  }
}
