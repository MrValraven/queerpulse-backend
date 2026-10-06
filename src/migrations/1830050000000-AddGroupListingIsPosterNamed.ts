// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `group_listings.is_poster_named` (LOC-F2): true when the room was posted
 * through the form that tells the poster the group page shows their name and
 * lets readers message them (PRD-443). Every room already on the table was
 * posted through the old anonymous form, so the column defaults to false and
 * needs no backfill. `HousingGroupsService.createListing` sets it to true
 * explicitly, so the default also keeps anonymous any row old code inserts
 * while the deploy rolls out.
 */
export class AddGroupListingIsPosterNamed1830050000000 implements MigrationInterface {
  name = 'AddGroupListingIsPosterNamed1830050000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group_listings" ADD COLUMN "is_poster_named" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "group_listings" DROP COLUMN "is_poster_named"`,
    );
  }
}
