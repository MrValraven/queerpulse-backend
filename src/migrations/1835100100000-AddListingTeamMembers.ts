// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Meet the team: `listing_team_members` links a business listing to a persona
 * by mutual consent. One live row (pending or accepted) per listing and
 * persona pair, enforced by a partial unique index; an accepted row carries a
 * position and every other status carries none.
 *
 * The table is new and empty, so every index builds inside the transaction.
 * The subprofile key cascades on update for ENG-447 (a persona id change
 * moves the row with it).
 */
export class AddListingTeamMembers1835100100000 implements MigrationInterface {
  name = 'AddListingTeamMembers1835100100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "listing_team_members_status_enum" AS ENUM ('pending', 'accepted', 'declined', 'cancelled', 'removed', 'left')`,
    );
    await queryRunner.query(
      `CREATE TYPE "listing_team_members_initiated_by_enum" AS ENUM ('listing', 'persona')`,
    );
    await queryRunner.query(`
      CREATE TABLE "listing_team_members" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "subprofile_id" uuid NOT NULL,
        "role_label" character varying(40),
        "status" "listing_team_members_status_enum" NOT NULL DEFAULT 'pending',
        "initiated_by" "listing_team_members_initiated_by_enum" NOT NULL,
        "requested_by_user_id" uuid,
        "answered_at" TIMESTAMP WITH TIME ZONE,
        "position" integer,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_listing_team_members" PRIMARY KEY ("id"),
        CONSTRAINT "CHK_listing_team_members_position" CHECK (("status" = 'accepted') = ("position" IS NOT NULL)),
        CONSTRAINT "FK_listing_team_members_listing" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_listing_team_members_subprofile" FOREIGN KEY ("subprofile_id") REFERENCES "subprofiles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_listing_team_members_requested_by" FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_listing_team_members_live_pair" ON "listing_team_members" ("listing_id", "subprofile_id") WHERE "status" IN ('pending', 'accepted')`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_team_members_listing_status" ON "listing_team_members" ("listing_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_team_members_subprofile_status" ON "listing_team_members" ("subprofile_id", "status")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_listing_team_members_requested_by_user_id" ON "listing_team_members" ("requested_by_user_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_listing_team_members_requested_by_user_id"`,
    );
    await queryRunner.query(`DROP TABLE "listing_team_members"`);
    await queryRunner.query(
      `DROP TYPE "listing_team_members_initiated_by_enum"`,
    );
    await queryRunner.query(`DROP TYPE "listing_team_members_status_enum"`);
  }
}
