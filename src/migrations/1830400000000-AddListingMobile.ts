// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Listings with no fixed premises
 * (`QUEERPULSE-NO-FIXED-PREMISES-DESIGN-2026-10-08.md`).
 *
 * `mobile` marks an "out and about" business: a walking tour, a mobile
 * hairdresser, a mover. `mobile_details` holds where it works
 * (`ListingMobileDetails`): all of Lisbon or some parishes, the nearby
 * municipalities it also travels to, and whether it works by appointment
 * only. Every existing row reads `'{}'`, which every reader normalises to the
 * default shape. The optional meeting point reuses `address`, `hood`,
 * `latitude`, `longitude` and `geocoded`, so no location column is added.
 *
 * `CHK_listings_not_online_and_mobile` keeps the two flags apart in the
 * database as well: the write rules answer 400 first, and the constraint
 * stops any other writer. Every existing row has `mobile = false`, so it
 * holds the moment it is added.
 *
 * `down`: the earlier code knows neither `tours` nor `home-services`. A live
 * listing whose only categories are those goes back to `review` first, so a
 * moderator recategorises it; then both slugs leave every `cats` array. The
 * constraint and the columns go last. A mobile listing reads as a place
 * afterwards; one with no meeting point has no pin, which the earlier code
 * already shows as a list-only place.
 */
export class AddListingMobile1830400000000 implements MigrationInterface {
  name = 'AddListingMobile1830400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "mobile" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD "mobile_details" jsonb NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" ADD CONSTRAINT "CHK_listings_not_online_and_mobile" CHECK ("online" = false OR "mobile" = false)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "listings" SET "status" = 'review' WHERE "status" = 'live' AND cardinality("cats") > 0 AND "cats" <@ ARRAY['tours', 'home-services']::text[]`,
    );
    await queryRunner.query(
      `UPDATE "listings" SET "cats" = array_remove(array_remove("cats", 'tours'), 'home-services') WHERE "cats" && ARRAY['tours', 'home-services']::text[]`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP CONSTRAINT "CHK_listings_not_online_and_mobile"`,
    );
    await queryRunner.query(
      `ALTER TABLE "listings" DROP COLUMN "mobile_details"`,
    );
    await queryRunner.query(`ALTER TABLE "listings" DROP COLUMN "mobile"`);
  }
}
