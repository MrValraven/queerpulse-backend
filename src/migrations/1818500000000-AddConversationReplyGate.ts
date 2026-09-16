import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * PRD-340 (one-tap reply): backs the explicit "opened" mechanism a non-connected
 * 1:1 conversation now needs before either side may send an ordinary follow-up.
 *
 * `initiator_user_id`: who started the thread as COLD contact. Set only for
 * `MessageRequestsService.deliverEnquiry`'s own deliveries going forward
 * (`MessagingCoreService.getOrCreateConversation`'s `coldContactInitiatorUserId`
 * is an explicit opt-in, never a default). Deliberately NEVER set for a
 * connected pair's ordinary DM (an accepted `messageRequest`,
 * `handleConnectionAccepted`, `ConversationsService.createConversation`).
 * Recording one there would let a later disconnect's reply gate treat
 * ordinary message history as consent to reopen the thread, which is exactly
 * the inference-from-history this feature must never make (a harasser could
 * simply avoid sending the first message). FK `ON DELETE SET NULL` (mirrors
 * `conversations.created_by`) so a deleted account never leaves a dangling
 * reference.
 *
 * `opened_at`: the instant the member who did NOT initiate posted their
 * first reply, per `MessagesService.sendMessage`'s connection-gate block.
 * From then on BOTH sides may send, exactly like an accepted-connection
 * thread, until a block voids it again (`ConversationsService`'s
 * `MEMBER_BLOCKED` handler). Removing a connection does NOT clear this: a
 * thread an enquiry opened stays open, because the recipient already
 * consented to it by replying, and that reply is the platform's own explicit
 * mechanism. It is exactly the thing this feature is allowed to rely on,
 * unlike inferred history.
 *
 * Both columns are nullable with no default, so every existing row lands
 * NULL, then `initiator_user_id` alone is backfilled below for the NARROW
 * case that is actually safe to infer: a DIRECT, non-official conversation
 * where
 *   1. the pair is NOT currently an accepted connection (a currently
 *      connected pair's thread never needs an initiator today, and giving it
 *      one would wrongly survive a FUTURE disconnect), AND
 *   2. every message in the thread was sent by the SAME single sender (an
 *      unanswered cold contact; the other side never replied, so there is
 *      nothing ambiguous to infer).
 * A thread where both sides have posted stays NULL regardless of current
 * connection status: two people who exchanged messages and are not connected
 * today (most commonly a formerly-connected pair who disconnected) must not
 * be treated as pre-opened from that history. Only a fresh explicit reply
 * opens a thread from here on, and `ConversationsService.replyGateFor` reads
 * a NULL initiator as `"needsConnection"` for both sides, matching the
 * platform's original, safe rule.
 */
export class AddConversationReplyGate1818500000000 implements MigrationInterface {
  name = 'AddConversationReplyGate1818500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "initiator_user_id" uuid`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD CONSTRAINT "FK_conversations_initiator_user_id" FOREIGN KEY ("initiator_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE NO ACTION`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" ADD "opened_at" TIMESTAMP WITH TIME ZONE`,
    );
    // Per DIRECT, non-official conversation: the sole sender if every message
    // came from ONE sender (including soft-deleted rows, since a since-deleted
    // message still counts as that sender having spoken), else NULL.
    // Two participant rows per direct conversation, ordered low/high uuid to
    // match `connections`' own `user_low`/`user_high` canonical pair columns.
    await queryRunner.query(`
      UPDATE "conversations" c
      SET "initiator_user_id" = agg.sole_sender_id
      FROM (
        SELECT
          m.conversation_id,
          (ARRAY_AGG(m.sender_id ORDER BY m.created_at ASC, m.id ASC))[1]
            AS sole_sender_id,
          COUNT(DISTINCT m.sender_id) AS distinct_senders
        FROM "messages" m
        GROUP BY m.conversation_id
      ) agg
      JOIN "conversation_participants" p1
        ON p1.conversation_id = agg.conversation_id
      JOIN "conversation_participants" p2
        ON p2.conversation_id = agg.conversation_id AND p2.user_id > p1.user_id
      WHERE c.id = agg.conversation_id
        AND c.kind = 'direct'
        AND c.is_official = false
        AND agg.distinct_senders = 1
        AND NOT EXISTS (
          SELECT 1 FROM "connections" conn
          WHERE conn.status = 'accepted'
            AND conn.user_low = p1.user_id
            AND conn.user_high = p2.user_id
        )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "opened_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP CONSTRAINT "FK_conversations_initiator_user_id"`,
    );
    await queryRunner.query(
      `ALTER TABLE "conversations" DROP COLUMN "initiator_user_id"`,
    );
  }
}
