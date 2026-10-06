// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `housing_listings.swept_at`: when the daily expiry sweep wrote the
 * listing's current `filled_at`. Owner surfaces used to infer a sweep fill
 * from `filled_at >= expires_at`, which misread two cases: an owner who marked
 * an already-expired listing filled before the sweep ran, and a sweep-filled
 * listing a moderator re-approved with a fresh `expires_at`. The sweep now
 * stamps this column together with `filled_at`.
 *
 * The backfill reproduces the old inference for existing rows, so every
 * listing reads exactly as it did the moment before this migration. Rows the
 * old rule misread keep that reading until their next owner action resets it.
 */
export class AddHousingListingSweptAt1829500500000 implements MigrationInterface {
  name = 'AddHousingListingSweptAt1829500500000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "swept_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "housing_listings" SET "swept_at" = "filled_at" WHERE "filled_at" IS NOT NULL AND "filled_at" >= "expires_at"`,
    );
    // Requested viewings stranded on homes the sweep hid before this deploy
    // can never be accepted, so they are cancelled here without a bell.
    await queryRunner.query(
      `UPDATE "housing_viewings" SET "status" = 'cancelled', "updated_at" = now() WHERE "status" = 'requested' AND "listing_id" IN (SELECT "id" FROM "housing_listings" WHERE "swept_at" IS NOT NULL)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    // The viewings `up` cancelled stay cancelled: which of them were requested
    // before is not recorded, and reopening a request on a hidden home would
    // strand it again.
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "swept_at"`,
    );
  }
}
