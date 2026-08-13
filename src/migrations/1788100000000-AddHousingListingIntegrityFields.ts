import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave B1 "listing integrity" — adds the transparency + risk-scoring columns to
 * `housing_listings`:
 *   - `accessibility_info`  (required-on-create step-free/lift/access line)
 *   - `lister_kind`         (member vs agent/broker disclosure — badged, not banned)
 *   - `risk_score`          (deterministic 0–100 pre-publish red-flag score)
 *   - `risk_reasons`        (stable machine codes behind the score)
 * All additive with safe defaults so existing rows migrate untouched.
 */
export class AddHousingListingIntegrityFields1788100000000 implements MigrationInterface {
  name = 'AddHousingListingIntegrityFields1788100000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TYPE "housing_listings_lister_kind_enum" AS ENUM('member', 'agent')`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "accessibility_info" character varying(300) NOT NULL DEFAULT ''`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "lister_kind" "housing_listings_lister_kind_enum" NOT NULL DEFAULT 'member'`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "risk_score" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" ADD "risk_reasons" text array NOT NULL DEFAULT '{}'`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_listings_risk_score" ON "housing_listings" ("risk_score")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_listings_risk_score"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "risk_reasons"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "risk_score"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "lister_kind"`,
    );
    await queryRunner.query(
      `ALTER TABLE "housing_listings" DROP COLUMN "accessibility_info"`,
    );
    await queryRunner.query(`DROP TYPE "housing_listings_lister_kind_enum"`);
  }
}
