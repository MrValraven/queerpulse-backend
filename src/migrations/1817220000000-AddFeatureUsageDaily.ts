// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `feature_usage_daily`, the durable half of feature usage awareness.
 *
 * NO INDEX BEYOND THE PRIMARY KEY, deliberately. The table gains at most 24
 * rows per day (one per key in `launchedFeatures`), so 24 months of retention
 * is roughly 17,500 rows at the ceiling. Every read is a full scan over a
 * table that small, and the composite primary key already covers the flush's
 * `ON CONFLICT` lookup.
 */
export class AddFeatureUsageDaily1817220000000 implements MigrationInterface {
  name = 'AddFeatureUsageDaily1817220000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "feature_usage_daily" (
        "day" date NOT NULL,
        "feature_key" character varying(64) NOT NULL,
        "request_count" integer NOT NULL DEFAULT 0,
        CONSTRAINT "PK_feature_usage_daily" PRIMARY KEY ("day", "feature_key")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "feature_usage_daily"`);
  }
}
