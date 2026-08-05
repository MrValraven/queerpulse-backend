import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `landing_feature`, the admin-curated slots (member quote, community
 * blurb, changemaker highlight) shown on the live landing page. Each row
 * pairs a `target_id` (the featured entity) with section-shaped `copy`,
 * validated server-side by `validateLandingCopy`.
 *
 * DO NOT RUN — authored for review only; the maintainer runs migrations.
 */
export class AddLandingFeature1785903200000 implements MigrationInterface {
  name = 'AddLandingFeature1785903200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TABLE "landing_feature" (
        "id" uuid NOT NULL DEFAULT uuid_generate_v4(),
        "section" character varying(20) NOT NULL,
        "target_id" uuid NOT NULL,
        "position" integer NOT NULL DEFAULT 0,
        "copy" jsonb NOT NULL,
        "active" boolean NOT NULL DEFAULT true,
        "created_by" uuid NOT NULL,
        "created_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT now(),
        CONSTRAINT "PK_landing_feature" PRIMARY KEY ("id")
      )
    `);
    await queryRunner.query(
      `CREATE UNIQUE INDEX "UQ_landing_feature_section_target" ON "landing_feature" ("section", "target_id")`,
    );
    await queryRunner.query(
      `CREATE INDEX "IDX_landing_feature_section_active_position" ON "landing_feature" ("section", "active", "position")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DROP INDEX "IDX_landing_feature_section_active_position"`,
    );
    await queryRunner.query(`DROP INDEX "UQ_landing_feature_section_target"`);
    await queryRunner.query(`DROP TABLE "landing_feature"`);
  }
}
