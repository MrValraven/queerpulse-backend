// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SEC-11: a browser that has verified an email code for an address draws its
 * later codes for that address from a reserved daily allowance, which a
 * stranger without that browser's cookie cannot spend. Each challenge row
 * records which bucket its send used, so the service counts the shared cap
 * and the trusted allowance apart. Every existing row was a shared-cap send,
 * so the column defaults to false.
 *
 * Adding a NOT NULL column with a constant default is a catalog-only change
 * on Postgres 11+, so the table is not rewritten. The existing
 * `IDX_email_sign_in_challenges_email_created_at` index still serves the
 * per-address count, which now filters on this column.
 */
export class AddEmailCodeTrustedSend1840860000000 implements MigrationInterface {
  name = 'AddEmailCodeTrustedSend1840860000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_sign_in_challenges" ADD "is_trusted_send" boolean NOT NULL DEFAULT false`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "email_sign_in_challenges" DROP COLUMN "is_trusted_send"`,
    );
  }
}
