// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `conversations.is_go_together_chat` (PRD-423, final review I1): a durable
 * marker that a group chat was formed by Go together matching. The first-name
 * rule used to read `event_match_group_id`, a foreign key `ON DELETE SET NULL`
 * to `event_match_groups`, so the rule lapsed the moment the group row went:
 * at once on a gathering's hard delete (ENG-433) and 90 days after the
 * gathering by retention. The chat outlives its group and still holds
 * strangers, so the marker lives on the conversation itself and never
 * changes. `event_match_group_id` keeps meaning "the group still exists"
 * (banner, closed-group guard).
 *
 * Backfill:
 * - every conversation linked to a group today is a Go together chat;
 * - every `mention` notification written inside one of those chats gains
 *   `payload.isGoTogetherChat = true`, the key `MessagesService` now writes
 *   at send time, so the bell and the Mentions inbox name the mentioner by
 *   first name on rows written before this migration too. The key is left
 *   out of the client payload allowlist and stays server side.
 *
 * A chat whose group was already deleted before this runs has no link left
 * to backfill from and keeps full names.
 *
 * `down` strips the payload key and drops the column.
 */
export class AddConversationIsGoTogetherChat1824300000000 implements MigrationInterface {
  name = 'AddConversationIsGoTogetherChat1824300000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "is_go_together_chat" boolean NOT NULL DEFAULT false`,
    );
    await queryRunner.query(
      `UPDATE "conversations" SET "is_go_together_chat" = true WHERE "event_match_group_id" IS NOT NULL`,
    );
    await queryRunner.query(`
      UPDATE "notifications" "n"
      SET "payload" = "n"."payload" || '{"isGoTogetherChat": true}'::jsonb
      WHERE "n"."type" = 'mention'
        AND "n"."payload" ->> 'source' = 'message'
        AND EXISTS (
          SELECT 1 FROM "conversations" "c"
          WHERE "c"."id"::text = "n"."payload" ->> 'conversationId'
            AND "c"."is_go_together_chat" = true
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "notifications"
      SET "payload" = "payload" - 'isGoTogetherChat'
      WHERE "type" = 'mention' AND "payload" ? 'isGoTogetherChat'
    `);
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "is_go_together_chat"`,
    );
  }
}
