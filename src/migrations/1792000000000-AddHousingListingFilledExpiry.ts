import { MigrationInterface, QueryRunner } from 'typeorm';

// HSG-1 / HSG-3: gives a housing listing owner a self-service "found a place"
// signal (`filled_at`) plus a TTL (`expires_at`) so a listing doesn't sit
// live forever once it's stale. Both are orthogonal to the existing `status`
// moderation enum (review/question/live) — members never self-transition
// that; these two columns are member-settable.
//
// `expires_at` is NOT NULL (mirrors `board_posts.expires_at` — see
// AddBoardPostLifecycleFields1791200100000): the 60-day DEFAULT only backfills
// existing rows at migration time, application code always computes and sets
// the real value on every future insert
// (HousingListingsService.DEFAULT_LISTING_LIFETIME_DAYS).
//
// The composite (status, expires_at) index backs both the public browse
// query's `status = 'live' AND expires_at > now()` filter and the daily
// expiry sweep's `status = 'live' AND filled_at IS NULL AND expires_at < now()`
// scan (see HousingListingExpirySweeperService).
export class AddHousingListingFilledExpiry1792000000000 implements MigrationInterface {
  name = 'AddHousingListingFilledExpiry1792000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "housing_listings"
        ADD COLUMN "filled_at" timestamptz NULL,
        ADD COLUMN "expires_at" timestamptz NOT NULL DEFAULT (now() + interval '60 days')
    `);
    await queryRunner.query(`
      CREATE INDEX "IDX_housing_listings_status_expires_at"
        ON "housing_listings" ("status", "expires_at")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP INDEX "IDX_housing_listings_status_expires_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "housing_listings"
        DROP COLUMN "filled_at",
        DROP COLUMN "expires_at"
    `);
  }
}
