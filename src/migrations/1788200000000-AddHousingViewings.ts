import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Viewing scheduling for member housing listings (P2.3). A `housing_viewings`
 * row is an enquirer's request to view a listing in person or over video, with
 * one or more proposed times; the lister accepts a slot, counter-proposes, or
 * declines. An accepted (or completed) viewing also unlocks the listing's
 * precise address for the requester.
 *
 * Additive — creates new enums + table only; no existing table is touched.
 */
export class AddHousingViewings1788200000000 implements MigrationInterface {
  name = 'AddHousingViewings1788200000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "housing_viewing_mode_enum" AS ENUM('in_person', 'video')`,
    );
    await queryRunner.query(
      `CREATE TYPE "housing_viewing_status_enum" AS ENUM('requested', 'accepted', 'declined', 'cancelled', 'completed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "housing_viewing_party_enum" AS ENUM('requester', 'lister')`,
    );

    await queryRunner.query(`
      CREATE TABLE "housing_viewings" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "requester_id" uuid NOT NULL,
        "lister_id" uuid NOT NULL,
        "mode" "housing_viewing_mode_enum" NOT NULL,
        "status" "housing_viewing_status_enum" NOT NULL DEFAULT 'requested',
        "proposed_by" "housing_viewing_party_enum" NOT NULL DEFAULT 'requester',
        "proposed_slots" TIMESTAMP WITH TIME ZONE array NOT NULL,
        "accepted_slot" TIMESTAMP WITH TIME ZONE,
        "note" text NOT NULL DEFAULT '',
        "response_note" text,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_viewings" PRIMARY KEY ("id")
      )
    `);

    await queryRunner.query(
      `CREATE INDEX "IDX_housing_viewings_listing_id" ON "housing_viewings" ("listing_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_viewings_requester_id" ON "housing_viewings" ("requester_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_viewings_lister_id" ON "housing_viewings" ("lister_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_viewings_status" ON "housing_viewings" ("status")`,
    );

    await queryRunner.query(
      `ALTER TABLE "housing_viewings" ADD CONSTRAINT "FK_housing_viewings_listing_id" FOREIGN KEY ("listing_id") REFERENCES "housing_listings"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_viewings" ADD CONSTRAINT "FK_housing_viewings_requester_id" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_viewings" ADD CONSTRAINT "FK_housing_viewings_lister_id" FOREIGN KEY ("lister_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_viewings" DROP CONSTRAINT "FK_housing_viewings_lister_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_viewings" DROP CONSTRAINT "FK_housing_viewings_requester_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_viewings" DROP CONSTRAINT "FK_housing_viewings_listing_id"`,
    );
    await queryRunner.query(`DROP TABLE "housing_viewings"`);
    await queryRunner.query(`DROP TYPE "housing_viewing_party_enum"`);
    await queryRunner.query(`DROP TYPE "housing_viewing_status_enum"`);
    await queryRunner.query(`DROP TYPE "housing_viewing_mode_enum"`);
  }
}
