// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the listing's optional cover photo (`{ image, alt }`), which directory
 * cards show ahead of the first gallery photo when it is set. Nullable with no
 * backfill: a listing without a cover keeps showing its first gallery photo
 * through `toCoverPhoto`'s fallback.
 */
export class AddListingCoverPhoto1830700000000 implements MigrationInterface {
  name = 'AddListingCoverPhoto1830700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "listings"
        ADD "cover_photo" jsonb DEFAULT NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "listings"
        DROP COLUMN "cover_photo"
    `);
  }
}
