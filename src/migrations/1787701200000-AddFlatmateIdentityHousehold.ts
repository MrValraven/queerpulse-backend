import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the consent-gated trans-affirming household prompts to flatmate profiles.
 * `identity_household` is a nullable jsonb holding `outAtHome` (moved here from
 * the ordinary `household_norms` because it can reveal orientation), plus the
 * new bathroom-sharing, mail-name and medication-privacy prompts — all Art.9
 * special-category, so served only under the existing consent + visibility gate.
 *
 * The ordinary co-living questionnaire fields (`noise`, `sharing`) live inside
 * the existing `household_norms` jsonb, so they need no column of their own.
 *
 * Nullable, so it applies cleanly to existing rows: they land with no gated
 * household data (served to no one) until the owner re-consents.
 */
export class AddFlatmateIdentityHousehold1787701200000 implements MigrationInterface {
  name = 'AddFlatmateIdentityHousehold1787701200000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" ADD "identity_household" jsonb`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "flatmate_profiles" DROP COLUMN "identity_household"`,
    );
  }
}
