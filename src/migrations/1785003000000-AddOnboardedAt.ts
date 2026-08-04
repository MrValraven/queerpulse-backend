import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Records when a member finished the one-time post-signup onboarding wizard
 * (`/auth/onboarding`). NULL means "not yet onboarded"; a timestamp means done.
 *
 * `AuthService`/the wizard stamp this via `POST /auth/onboarding/complete` when a
 * new member reaches the final step, and `AuthUser.onboardedAt` surfaces it to
 * the client so the auth gate can bounce an already-onboarded member off the
 * wizard (browser autofill of the saved `/auth/onboarding` URL is the common way
 * they land back on it) instead of silently letting them replay it — which could
 * overwrite profile fields the intents step re-submits.
 *
 * Unlike `age_attested_at`, this IS backfilled: every row existing when this runs
 * belongs to an established, active member who demonstrably completed signup, so
 * treating them as onboarded is the truth, not a manufactured act. `created_at`
 * is the honest proxy for "has been a member since". Without the backfill those
 * members would read as never-onboarded and hit the very bug this closes.
 */
export class AddOnboardedAt1785003000000 implements MigrationInterface {
  name = 'AddOnboardedAt1785003000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users"
      ADD "onboarded_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      UPDATE "users"
      SET "onboarded_at" = "created_at"
      WHERE "onboarded_at" IS NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "users" DROP COLUMN "onboarded_at"
    `);
  }
}
