// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Three additive columns on `housing_listings`:
 *
 * - `deleted_at` (ENG-466): an owner deleting a listing now soft-deletes it
 *   (`@DeleteDateColumn`). The `housing_viewings` and `housing_reviews` foreign
 *   keys cascade on a hard delete, so removing a home used to erase every
 *   viewing and every review written about it. The row now stays, every
 *   TypeORM read skips it, and the unique `slug` index still covers it, which
 *   is why the slug allocator checks with `withDeleted`.
 * - `relisted_at` (ENG-467): stamped when an owner marks a FILLED listing as
 *   available again. A completed viewing from before that moment no longer
 *   unlocks the exact address of the relisted home.
 * - `geocode_attempts` (ENG-469): how many times the private address failed to
 *   geocode. The hourly retry sweep picks up listings with an address and no
 *   coordinates while this is under its cap; an address change resets it.
 *
 * All three are nullable or defaulted, so existing rows need no backfill.
 */
export class AddHousingListingSoftDeleteRelistAndGeocodeAttempts1829500000000 implements MigrationInterface {
  name = 'AddHousingListingSoftDeleteRelistAndGeocodeAttempts1829500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "deleted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "relisted_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "geocode_attempts" integer NOT NULL DEFAULT 0`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "geocode_attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "relisted_at"`,
    );
    // Restores the hard-delete semantics: a soft-deleted row is deleted for
    // real, cascading to its viewings and reviews as before this migration.
    await queryRunner.query(
      `DELETE FROM "housing_listings" WHERE "deleted_at" IS NOT NULL`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "deleted_at"`,
    );
  }
}
