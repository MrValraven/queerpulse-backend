import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * BE-HSG-09: makes the "real recorded interaction" premise behind two-sided
 * housing reviews actually hold.
 *
 * Two indexes:
 *
 *  1. `UQ_housing_viewings_open` — PARTIAL unique on
 *     (listing_id, requester_id) WHERE status IN ('requested','accepted').
 *     `HousingViewingsService.request` had no dedupe of any kind, so one member
 *     could open unlimited viewings on a single listing, and every one a lister
 *     accepted became another reviewable "interaction". Partial rather than
 *     full, so a declined/cancelled/completed viewing does not block the member
 *     from ever arranging another visit to the same home.
 *
 *  2. `UQ_housing_reviews_listing_author` — unique on
 *     (listing_id, author_id, author_role). Review uniqueness was per
 *     (viewing_id, author_id) only, so the same member could review one listing
 *     again for each viewing they opened on it. `author_role` is part of the key
 *     because a member can legitimately be BOTH sides across two different
 *     viewings of the same listing (a lister reviewing a guest, and separately a
 *     guest reviewing a lister); this constrains each role to one review.
 *
 * BACKFILL / PRE-EXISTING DUPLICATES: both are created NON-concurrently inside
 * the migration transaction, so either will FAIL LOUDLY if the table already
 * contains rows that violate it. That is deliberate — silently keeping a
 * duplicate would leave exactly the forged-review data the constraint exists to
 * prevent. If `migration:run` fails here, inspect and resolve the duplicates
 * before re-running:
 *
 *   SELECT listing_id, requester_id, count(*) FROM housing_viewings
 *   WHERE status IN ('requested','accepted')
 *   GROUP BY 1,2 HAVING count(*) > 1;
 *
 *   SELECT listing_id, author_id, author_role, count(*) FROM housing_reviews
 *   GROUP BY 1,2,3 HAVING count(*) > 1;
 *
 * NOT `CREATE INDEX CONCURRENTLY`: these are unique indexes whose whole purpose
 * is to reject bad rows at creation time, and a concurrent build would need its
 * own non-transactional migration. Both tables are small (viewings are a
 * per-listing handful), so a brief lock is the right trade.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddHousingViewingAndReviewUniqueness1793530600000 implements MigrationInterface {
  name = 'AddHousingViewingAndReviewUniqueness1793530600000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_viewings_open"
         ON "housing_viewings" ("listing_id", "requester_id")
         WHERE "status" IN ('requested', 'accepted')`,
    );
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_housing_reviews_listing_author"
         ON "housing_reviews" ("listing_id", "author_id", "author_role")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP INDEX "UQ_housing_reviews_listing_author"`);
    await queryRunner.query(`DROP INDEX "UQ_housing_viewings_open"`);
  }
}
