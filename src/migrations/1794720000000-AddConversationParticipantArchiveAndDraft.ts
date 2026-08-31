import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Two additive, nullable columns on `conversation_participants`:
 *
 * `archived_at` — when this participant archived the conversation out of
 * their main inbox. The intended replacement for "clear for me"
 * (`cleared_at`, unchanged) as the everyday way to declutter: reversible, and
 * auto-cleared server-side the instant a genuinely new message lands in the
 * conversation (`MessagingCoreService.buildPostResult`), so it can never
 * silently swallow a reply the way the destructive clear could read as doing.
 *
 * `draft` — this participant's own unsent composer text, synced from the
 * client (debounced) so an unsent draft survives a device switch. The
 * cross-device layer on top of the always-on, per-keystroke localStorage copy
 * (`features/messages/drafts.ts`) that stays the instant local layer.
 *
 * Both nullable with no default and no backfill: every existing row starts
 * NULL (not archived, no draft), which is the correct existing state for
 * every conversation participant today. Two plain `ADD COLUMN`s against an
 * existing table with no new index — no `CONCURRENTLY` split needed.
 */
export class AddConversationParticipantArchiveAndDraft1794720000000 implements MigrationInterface {
  name = 'AddConversationParticipantArchiveAndDraft1794720000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN "archived_at" timestamptz NULL,
        ADD COLUMN "draft" text NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "draft",
        DROP COLUMN "archived_at"
    `);
  }
}
