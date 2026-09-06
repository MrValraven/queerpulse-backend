// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-244. Adds `housing_listings.expiry_warning_sent_at`, the once-per-term
 * guard behind the `housing_listing_expiring` notification.
 *
 * WHY A COLUMN AND NOT A WINDOW. The warning sweep runs on the same midnight
 * tick as the expiry sweep and selects every live listing lapsing inside the
 * next seven days. Without a persisted marker that set is the same set every
 * night, so a lister would be told seven times that one listing is about to
 * expire. The claim is a conditional `UPDATE ... WHERE expiry_warning_sent_at
 * IS NULL`, so two replicas ticking together send once between them.
 *
 * CLEARED ON EVERY PATH THAT EXTENDS THE TERM, which is the part that is easy
 * to miss and turns the feature into a one-shot if missed: `extend()`,
 * `markAvailable()` (which refreshes a stale expiry so the sweep does not
 * immediately re-fill the listing) and `HousingListingModerationService.decide()`
 * (approval refreshes an expiry that lapsed while the listing sat in the queue).
 *
 * NO BACKFILL. NULL already means "not warned for this term", which is the
 * correct reading for every existing row. The first tick warns whatever is
 * genuinely inside the window, bounded to 500 rows per run.
 *
 * NO INDEX. The sweep's predicate is `status = 'live'` (equality on the leading
 * column) plus a range on `expires_at`, ordered by `expires_at`, which is
 * exactly the shape `IDX_housing_listings_status_expires_at` was built for, and
 * the ORDER BY matches index order so there is no sort. This column is a
 * residual filter on at most 500 returned rows.
 */
export class AddHousingListingExpiryWarningSentAt1817010000000
  implements MigrationInterface
{
  name = 'AddHousingListingExpiryWarningSentAt1817010000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD COLUMN IF NOT EXISTS "expiry_warning_sent_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN IF EXISTS "expiry_warning_sent_at"`,
    );
  }
}
