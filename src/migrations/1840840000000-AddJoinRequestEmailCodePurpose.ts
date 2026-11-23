// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SEC-10: an applicant confirms the address on a join request with a 6-digit
 * email code before the request is filed. Those codes are rows in
 * `email_sign_in_challenges` under their own purpose, `join_request`, so they
 * keep their own per-address send cap and can never be typed back on the
 * sign-in or reauth routes.
 *
 * TRANSACTIONAL: on Postgres 12+ `ALTER TYPE ... ADD VALUE` may run inside the
 * default wrapping transaction as long as nothing in that transaction uses the
 * new label, and nothing here does.
 */
export class AddJoinRequestEmailCodePurpose1840840000000 implements MigrationInterface {
  name = 'AddJoinRequestEmailCodePurpose1840840000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TYPE "email_sign_in_challenge_purpose_enum" ADD VALUE IF NOT EXISTS 'join_request'`,
    );
  }

  /**
   * The `join_request` label stays in the enum: Postgres cannot drop an enum
   * value, and the label is inert once no row carries it. The rows go, so a
   * code issued under the label cannot outlive the rollback.
   */
  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `DELETE FROM "email_sign_in_challenges" WHERE "purpose" = 'join_request'`,
    );
  }
}
