// Applied at backend boot while pending: `ensureDatabaseSchema` (called from
// `src/main.ts`) runs every pending migration at startup unless
// `AUTO_RUN_MIGRATIONS=false` is set. To apply it by hand instead, set that
// flag, check `pnpm run typeorm migration:show`, then `pnpm run migration:run`.
// This one deletes data (mention notifications leaked out of private
// conversations), so count the rows it will remove before a boot applies it:
// run the `SELECT count(*)` twin of the `DELETE` below.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * ENG-400 cleanup. Until the fix in `MentionNotificationService`
 * (`restrictGroupsToSource`), a `c/`, `e/`, `b/` or `t/` mention written
 * inside a DM or group notified the community owner and mods, event host,
 * listing owner or thread author even when they held no seat in that
 * conversation. Each of those rows is a `mention` notification whose payload
 * carries `source: 'message'`, the `conversationId` and a 140-char `excerpt`
 * of the private message. The bell, the mentions inbox and the data export
 * all read these rows from `notifications`, so deleting them here removes the
 * excerpt from all three. A push already delivered cannot be recalled.
 *
 * A row is deleted when the conversation it names still exists and its
 * recipient had no live seat in it when the notification was written:
 * - no `conversation_participants` row for the recipient at all, or
 * - a row whose `left_at` is earlier than the notification's `created_at`
 *   (they had left or been removed before the mention was sent).
 *
 * Kept on purpose, because they cannot be told apart from legitimate rows:
 * - a recipient who has a live seat today (`left_at` NULL), including one
 *   added to the conversation after the mention; seats carry no join time;
 * - a recipient who left after the mention was sent;
 * - rows naming a conversation that no longer exists;
 * - a mailbox staff seat that the Task 13f/14 excluded-seat rule
 *   (`seatExcludedFromMailboxPredicate`) would drop today but that held a
 *   live participant row when the mention was sent. Seat state at mention
 *   time cannot be reconstructed; the mentions inbox already hides those rows
 *   while the exclusion stands (`visibleThroughMailboxSeatRules`).
 *
 * So this sweeps the provable leaks only.
 *
 * The recipient match runs on `user_id` against the payload's
 * `conversationId`, compared as text so a malformed payload value can never
 * fail the cast and abort the migration.
 *
 * `up` logs how many rows it removed, so the deploy log records the purge.
 *
 * `down` is a no-op: the deleted rows were leaks and are not restored.
 */
export class DeleteLeakedConversationMentionNotifications1823500000000 implements MigrationInterface {
  name = 'DeleteLeakedConversationMentionNotifications1823500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    const rows: { deletedCount: number }[] = await queryRunner.query(`
      WITH "deleted" AS (
        DELETE FROM "notifications" "n"
        WHERE "n"."type" = 'mention'
          AND "n"."payload" ->> 'source' = 'message'
          AND EXISTS (
            SELECT 1 FROM "conversations" "c"
            WHERE "c"."id"::text = "n"."payload" ->> 'conversationId'
          )
          AND NOT EXISTS (
            SELECT 1 FROM "conversation_participants" "cp"
            WHERE "cp"."conversation_id"::text = "n"."payload" ->> 'conversationId'
              AND "cp"."user_id" = "n"."user_id"
              AND ("cp"."left_at" IS NULL OR "cp"."left_at" >= "n"."created_at")
          )
        RETURNING 1
      )
      SELECT count(*)::int AS "deletedCount" FROM "deleted"
    `);
    // Deliberately loud: the one record of how many leaked rows were removed.
    console.log(
      `[DeleteLeakedConversationMentionNotifications] deleted ${rows[0]?.deletedCount ?? 0} mention notification(s)`,
    );
  }

  public async down(): Promise<void> {
    // Irreversible by design: see the class comment.
  }
}
