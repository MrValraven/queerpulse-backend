import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `users.affirming_pledge_accepted_at` — the member-level stamp for the
 * LGBTQ+ affirming housing pledge (the mandatory universal baseline every
 * housing write/contact action gates on; see `AffirmingPledgeService`).
 *
 * Additive and safe. Deliberately NOT backfilled (mirrors
 * `AddGuidelinesAgreement`, not `AddOnboardedAt`): accepting the pledge is a
 * specific, legally-meaningful act, so a manufactured timestamp would be a lie.
 * Existing members keep NULL and browse housing exactly as before — nothing is
 * blocked by this migration; the gate lives in application code and only fires
 * on a WRITE/CONTACT action, prompting a one-time acceptance.
 */
export class AddAffirmingPledge1788400000000 implements MigrationInterface {
  name = 'AddAffirmingPledge1788400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "affirming_pledge_accepted_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "affirming_pledge_accepted_at"`,
    );
  }
}
