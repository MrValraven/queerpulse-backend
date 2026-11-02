// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Directory partners: the businesses an admin hand-picked for the row at the
 * top of the public directory, at most 12, in a chosen order.
 *
 * `UQ_directory_partner_picks_position` is DEFERRABLE INITIALLY IMMEDIATE: a
 * reorder rewrites every position in one statement under
 * `SET CONSTRAINTS ... DEFERRED`, and a remove closes the gap in one
 * statement. The unique on `listing_id` doubles as its index.
 *
 * The table is new and empty, so it builds inside the migration transaction.
 * A listing deleted by staff takes its pick with it (cascade). The statements
 * carry no `IF NOT EXISTS` guards.
 */
export class AddDirectoryPartnerPicks1838700000000 implements MigrationInterface {
  name = 'AddDirectoryPartnerPicks1838700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "directory_partner_picks" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "listing_id" uuid NOT NULL,
        "note" character varying(140),
        "position" smallint NOT NULL,
        "created_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_directory_partner_picks" PRIMARY KEY ("id"),
        CONSTRAINT "UQ_directory_partner_picks_listing" UNIQUE ("listing_id"),
        CONSTRAINT "UQ_directory_partner_picks_position" UNIQUE ("position") DEFERRABLE INITIALLY IMMEDIATE,
        CONSTRAINT "CHK_directory_partner_picks_position" CHECK ("position" >= 1),
        CONSTRAINT "FK_directory_partner_picks_listing" FOREIGN KEY ("listing_id") REFERENCES "listings"("id") ON DELETE CASCADE ON UPDATE CASCADE,
        CONSTRAINT "FK_directory_partner_picks_created_by" FOREIGN KEY ("created_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "directory_partner_picks"`);
  }
}
