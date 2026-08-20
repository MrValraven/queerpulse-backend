import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `restricted` / `restricted_until` to `users`: the real, enforced effect
 * behind the moderation queue's `restrict` action (`PATCH /mod/reports/:id`
 * with `action: "restrict"`), which previously wrote an audit row and resolved
 * the report with no effect on the account at all.
 *
 * Deliberately NOT a reuse of `status`/`suspended_until` (that pair is a full
 * account lockout via `ActiveMemberGuard`): a restriction is lighter — the
 * member keeps signing in and browsing normally, and is only blocked from the
 * specific write actions gated by `NotRestrictedGuard` (forum thread + reply
 * creation). `restricted` is not-null with a `false` default so every existing
 * member lands unrestricted; `restricted_until` is nullable and only
 * meaningful while `restricted = true`.
 */
export class AddMemberRestriction1791700000000 implements MigrationInterface {
  name = 'AddMemberRestriction1791700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "restricted" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `ALTER TABLE "users" ADD "restricted_until" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "restricted_until"`,
    );
    await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "restricted"`);
  }
}
