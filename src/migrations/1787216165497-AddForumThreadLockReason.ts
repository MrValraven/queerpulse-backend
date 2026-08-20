import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds an optional `lock_reason` note to `forum_thread`, set alongside
 * `is_locked` by `ForumThreadsService.setLocked` when a moderator locks a
 * thread with a reason. Nullable with no default (existing threads and every
 * lock cast before this note existed simply have `null`) — the locked banner
 * only shows a reason line when one is present. Cleared back to `null` on
 * unlock, mirroring `pinned_at`'s "watermark tied to the current state, not an
 * append-only log" precedent (see `AddForumThreadPinnedAt`).
 */
export class AddForumThreadLockReason1787216165497 implements MigrationInterface {
  name = 'AddForumThreadLockReason1787216165497';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "lock_reason" character varying(280)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "lock_reason"`,
    );
  }
}
