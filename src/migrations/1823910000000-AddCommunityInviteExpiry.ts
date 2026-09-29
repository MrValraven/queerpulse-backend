// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `community_invites.expires_at` (ENG-429): an invitation now lapses 30 days
 * after it is sent. Backfill gives every existing row
 * GREATEST(created_at + 30 days, now() + 14 days), so an invitation already
 * older than the window still has two weeks before it lapses. The value on
 * non-pending rows is inert. The default keeps both insert paths
 * (`CommunityInvitesService.recordInvites`, `CommunitiesService.recordInvites`)
 * unchanged.
 */
export class AddCommunityInviteExpiry1823910000000 implements MigrationInterface {
  name = 'AddCommunityInviteExpiry1823910000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_invites" ADD "expires_at" TIMESTAMP WITH TIME ZONE`,
    );
    await queryRunner.query(
      `UPDATE "community_invites" SET "expires_at" = GREATEST("created_at" + interval '30 days', now() + interval '14 days')`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_invites" ALTER COLUMN "expires_at" SET DEFAULT (now() + interval '30 days')`,
    );
    await queryRunner.query(
      `ALTER TABLE "community_invites" ALTER COLUMN "expires_at" SET NOT NULL`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_invites" DROP COLUMN "expires_at"`,
    );
  }
}
