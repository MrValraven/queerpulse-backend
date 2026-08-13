import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the GDPR Art.9-safe identity & safe-space fields to flatmate profiles.
 * Every column is nullable (or carries a default) so it is safe to apply on top
 * of existing rows: they land with no consent (`special_category_consent_at`
 * NULL) and therefore have their special-category fields served to no one.
 */
export class AddFlatmateIdentityFields1787700700000 implements MigrationInterface {
  name = 'AddFlatmateIdentityFields1787700700000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "gender_identity" character varying(120)`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "safe_space_needs" text array`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "household_norms" jsonb`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "identity_visibility" character varying(20) DEFAULT 'matches'`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "special_category_consent_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "special_category_consent_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "identity_visibility"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "household_norms"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "safe_space_needs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "gender_identity"`,
    );
  }
}
