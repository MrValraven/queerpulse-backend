// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds `has_invite_access` to `users`: the per-member lever an admin flips
 * through `PATCH /admin/members/:id/invite-access` to pause a member's ability
 * to invite new people to the platform, leaving the rest of the account as is.
 * Enforced in `InvitesService` on invite create and resend.
 *
 * Not-null with a `true` default, so every existing member keeps inviting. A
 * constant default is a metadata-only change on PostgreSQL 11+: no table
 * rewrite, and existing rows read `true` straight away.
 */
export class AddUserInviteAccess1837410000000 implements MigrationInterface {
  name = 'AddUserInviteAccess1837410000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" ADD "has_invite_access" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "users" DROP COLUMN "has_invite_access"`,
    );
  }
}
