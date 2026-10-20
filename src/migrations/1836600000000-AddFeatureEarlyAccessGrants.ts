// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-member early access (`QUEERPULSE-EARLY-ACCESS-PLAN-2026-10-20.md`,
 * section 1): one row per member and feature key. The row is the grant;
 * deleting it revokes. `feature_key` is a plain varchar so the next feature in
 * early access needs no migration; the registry in `src/launchedFeatures.ts`
 * decides which keys mean anything.
 *
 * `user_id` cascades on delete, so an erased member takes their grants along.
 * `granted_by_id` is set null when the staff account is erased, keeping the
 * grant itself.
 *
 * `UQ_feature_early_access_grants_user_feature` serves the per-request EXISTS
 * check on `(user_id, feature_key)` and makes a grant idempotent. The admin
 * roster reads `IDX_feature_early_access_grants_feature_created_at` newest
 * first, and `IDX_feature_early_access_grants_granted_by_id` keeps the
 * SET NULL on a staff erasure off a sequential scan.
 *
 * The table is new and empty, so every index builds inside the migration
 * transaction.
 */
export class AddFeatureEarlyAccessGrants1836600000000 implements MigrationInterface {
  name = 'AddFeatureEarlyAccessGrants1836600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "feature_early_access_grants" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "user_id" uuid NOT NULL,
        "feature_key" character varying(64) NOT NULL,
        "granted_by_id" uuid,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_feature_early_access_grants" PRIMARY KEY ("id"),
        CONSTRAINT "FK_feature_early_access_grants_user" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
        CONSTRAINT "FK_feature_early_access_grants_granted_by" FOREIGN KEY ("granted_by_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_feature_early_access_grants_user_feature" ON "feature_early_access_grants" ("user_id", "feature_key")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feature_early_access_grants_feature_created_at" ON "feature_early_access_grants" ("feature_key", "created_at" DESC, "id" DESC)`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_feature_early_access_grants_granted_by_id" ON "feature_early_access_grants" ("granted_by_id")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "feature_early_access_grants"`);
  }
}
