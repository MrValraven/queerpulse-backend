import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Wave B3 P2.5 — member saved housing searches. A named, structured filter set
 * (`criteria` jsonb) plus an `alerts_enabled` flag; when on, a new listing going
 * live that matches is delivered as a notification to the member. Indexed by
 * `member_id` (the member's own list) and `alerts_enabled` (the go-live alerts
 * scan). Transactional — plain table + index DDL only.
 */
export class AddHousingSavedSearches1788300100000 implements MigrationInterface {
  name = 'AddHousingSavedSearches1788300100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `CREATE TABLE "housing_saved_searches" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "member_id" uuid NOT NULL,
        "name" character varying(80) NOT NULL,
        "criteria" jsonb NOT NULL DEFAULT '{}',
        "alerts_enabled" boolean NOT NULL DEFAULT true,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_housing_saved_searches" PRIMARY KEY ("id")
      )`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_saved_searches_member_id" ON "housing_saved_searches" ("member_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_housing_saved_searches_alerts_enabled" ON "housing_saved_searches" ("alerts_enabled")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_saved_searches_alerts_enabled"`,
    );
    await queryRunner.query(
      `DROP INDEX "public"."IDX_housing_saved_searches_member_id"`,
    );
    await queryRunner.query(`DROP TABLE "housing_saved_searches"`);
  }
}
