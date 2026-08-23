// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-member, per-community notification volume
 * (`community_members.notification_level`).
 *
 * Membership was previously all-or-nothing for notifications, which forces a
 * member of a busy community to choose between a bell that never stops and
 * leaving the community. Four levels: `all` (every post), `announcements`
 * (only what an owner/mod marks as one), `mentions` (only threads naming
 * them), `muted` (nothing from this community). The level can only ever reduce
 * what a member receives; their platform-wide notification preferences still
 * apply on top of it.
 *
 * NOT NULL, defaulting to `announcements` rather than `all`. Two reasons: a
 * bell that fires on every post in every community trains people to ignore it,
 * and `announcements` is the level that keeps the important message loud. The
 * server-side default backfills every existing roster row in the same
 * metadata-only `ADD COLUMN`, so no notification path ever has to handle NULL.
 */
export class AddCommunityMemberNotificationLevel1793830000000 implements MigrationInterface {
  name = 'AddCommunityMemberNotificationLevel1793830000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE TYPE "community_members_notification_level_enum" AS ENUM
        ('all', 'announcements', 'mentions', 'muted')
    `);
    await queryRunner.query(`
      ALTER TABLE "community_members"
        ADD "notification_level" "community_members_notification_level_enum"
        NOT NULL DEFAULT 'announcements'
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "community_members" DROP COLUMN "notification_level"`,
    );
    await queryRunner.query(
      `DROP TYPE "community_members_notification_level_enum"`,
    );
  }
}
