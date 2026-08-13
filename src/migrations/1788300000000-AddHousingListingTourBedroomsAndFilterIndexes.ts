import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave B3 "listing discovery":
 *   - `virtual_tour_url` (optional https 360°/virtual-tour link, P2.2)
 *   - `bedrooms`         (bedroom count / 0 = studio, powers the beds filter)
 * plus indexes for the hot housing-directory filter + sort columns (P2.5):
 *   - (status, created_at)   the base "live, newest first" browse + its sort
 *   - rent_euros             price-range filters
 *   - available_from         move-in-by filter
 *   - bedrooms               beds filter (indexed above via @Index too)
 *   - LOWER(area) / LOWER(city)  case-insensitive area/city equality filters
 *
 * All additive with safe defaults / nullable, so existing rows migrate
 * untouched. Plain `CREATE INDEX` (not CONCURRENTLY) because this runs inside
 * the per-migration transaction; a production run against a large, live
 * `housing_listings` would switch these to CONCURRENTLY in a `transaction=false`
 * migration (see the AddSubprofileDirectoryBrowseIndex precedent).
 */
export class AddHousingListingTourBedroomsAndFilterIndexes1788300000000 implements MigrationInterface {
  name = 'AddHousingListingTourBedroomsAndFilterIndexes1788300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "bedrooms" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "virtual_tour_url" character varying(500)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_bedrooms" ON "housing_listings" ("bedrooms")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_status_created_at" ON "housing_listings" ("status", "created_at")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_rent_euros" ON "housing_listings" ("rent_euros")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_available_from" ON "housing_listings" ("available_from")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_area_lower" ON "housing_listings" (LOWER("area"))`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_city_lower" ON "housing_listings" (LOWER("city"))`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_city_lower"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_area_lower"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_available_from"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_rent_euros"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_status_created_at"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_bedrooms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "virtual_tour_url"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "bedrooms"`,
    );
  }
}
