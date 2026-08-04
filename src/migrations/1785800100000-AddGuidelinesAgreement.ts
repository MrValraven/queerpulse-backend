import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records a member's agreement to the community guidelines — the checkbox on the
 * onboarding welcome step (`OnboardingSteps`). `guidelines_accepted_at` is the
 * moment they agreed; `guidelines_version` is the guidelines revision they
 * agreed to (client-supplied when the wizard sends it, otherwise the server's
 * `CURRENT_GUIDELINES_VERSION`). Both are stamped together with `onboarded_at`
 * by `UsersService.markOnboarded`.
 *
 * Deliberately NOT backfilled (unlike `onboarded_at`): agreeing to the
 * guidelines is a specific, deliberate act, so writing a manufactured timestamp
 * for a member who never actually saw this step would be a falsified consent
 * record. Pre-existing rows stay NULL — the honest "no explicit agreement on
 * file" — and only stamp forward the next time a member completes onboarding.
 */
export class AddGuidelinesAgreement1785800100000 implements MigrationInterface {
  name = 'AddGuidelinesAgreement1785800100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "guidelines_accepted_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "guidelines_version" character varying(32)
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "guidelines_version"`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "guidelines_accepted_at"`,
    );
  }
}
