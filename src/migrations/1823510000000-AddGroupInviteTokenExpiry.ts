// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `conversations.invite_token_expires_at` (PRD-400): a group's join-by-link
 * token now lapses 7 days after it is issued or rotated
 * (`GROUP_INVITE_LINK_TTL_MS`). The column is nullable because a conversation
 * with no live link (every DM, and a group whose link is off) has no expiry
 * to hold.
 *
 * Backfill: every group that has a live token today gets
 * `now() + 7 days`, measured from the moment this migration runs, so a link
 * already shared keeps working for one more week and then needs re-issuing
 * from the group's invite-link panel. Rows with no token stay NULL.
 */
export class AddGroupInviteTokenExpiry1823510000000 implements MigrationInterface {
  name = 'AddGroupInviteTokenExpiry1823510000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "invite_token_expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "conversations" SET "invite_token_expires_at" = now() + interval '7 days' WHERE "invite_token" IS NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "invite_token_expires_at"`,
    );
  }
}
