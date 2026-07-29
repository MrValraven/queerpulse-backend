// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds a per-participant `cleared_at` watermark to `conversation_participants`.
 * Deleting a conversation "for me" (WhatsApp-style) sets this to now(); reads
 * then treat only messages newer than it as existing for that user. NULL means
 * never-cleared. Mirrors the existing per-user `last_read_at` / `muted` columns.
 * See `src/messaging/entities/conversation-participant.entity.ts`.
 */
export class AddConversationClearedAt1785000340000 implements MigrationInterface {
  name = 'AddConversationClearedAt1785000340000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" ADD "cleared_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversation_participants" DROP COLUMN "cleared_at"`,
    );
  }
}
