// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds precise geolocation + full street address to member housing listings,
 * powering the map pin and the address-privacy gate (precise point/address are
 * served only to the owner or an accepted enquirer; everyone else gets an
 * approximate neighbourhood-centroid pin computed at the response boundary).
 *
 * Every column is NULLABLE with no default, so this is safe on existing rows —
 * they simply carry no exact point (the app falls back to the area centroid)
 * and no address until one is set.
 */
export class AddHousingListingLocation1786100000000 implements MigrationInterface {
  name = 'AddHousingListingLocation1786100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN "latitude" numeric(9,6)`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN "longitude" numeric(9,6)`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN "address_line" character varying(200)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "address_line"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "longitude"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "latitude"`,
    );
  }
}
