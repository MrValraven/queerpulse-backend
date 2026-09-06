import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One additive, nullable column on `conversation_participants` (PRD-225):
 *
 * `marked_unread_at` — when THIS participant explicitly marked the
 * conversation unread from the inbox row menu (WhatsApp/Telegram/Signal's
 * "mark as unread"), so a thread they've genuinely read can still be flagged
 * to come back to. Server state (not client-local) so it survives navigating
 * away and shows up on the member's other devices, mirroring `pinnedAt`/
 * `favoritedAt`/`archivedAt`. Deliberately independent of `last_read_at`:
 * `ConversationsService.markRead` advances `last_read_at`/`delivered_at`
 * monotonically forward (via `GREATEST`) and can never be walked backward, so
 * a manual "mark unread" cannot and does not touch it — instead it is its own
 * timestamp, cleared back to NULL only by `markRead` itself (i.e. genuinely
 * re-opening/reading the thread), never by an inbox refetch or an unrelated
 * preference toggle.
 *
 * Nullable with no default and no backfill: every existing row starts NULL
 * (not manually marked unread), the correct existing state for every
 * conversation participant today. A single plain `ADD COLUMN` against an
 * existing table with no new index — no `CONCURRENTLY` split needed.
 */
export class AddConversationParticipantMarkedUnread1815110000000 implements MigrationInterface {
  name = 'AddConversationParticipantMarkedUnread1815110000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN "marked_unread_at" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "marked_unread_at"
    `);
  }
}
