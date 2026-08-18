import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a `pinned_at` watermark to `forum_thread`, mirroring
 * `conversation_participants.pinned_at` (see `AddConversationPinFavorite`):
 * NULL = never pinned, a timestamp = pinned since then, so multiple pinned
 * threads order deterministically (`pinned_at DESC`). `is_pinned` itself
 * already existed from `AddForum`; this migration only adds the watermark
 * used for ordering. Nullable with no default, so it applies cleanly to
 * existing rows (every current thread lands unpinned). The pinned-thread cap
 * is enforced in application code (`ForumThreadsService.setPinned`), not the
 * schema — same precedent as the conversation pin cap.
 */
export class AddForumThreadPinnedAt1791400000000 implements MigrationInterface {
  name = 'AddForumThreadPinnedAt1791400000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" ADD "pinned_at" TIMESTAMP(3) WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "forum_thread" DROP COLUMN "pinned_at"`,
    );
  }
}
