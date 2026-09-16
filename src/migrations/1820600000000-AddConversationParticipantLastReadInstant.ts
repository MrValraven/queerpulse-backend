import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * One additive, nullable column on `conversation_participants` (PRD-351):
 *
 * `last_read_instant`: the server clock's own timestamp at the moment
 * `ConversationsService.markRead` actually ran, distinct from `last_read_at`
 * (the pre-existing column). `last_read_at` is a WATERMARK, set to the
 * `created_at` of the newest message the reader was shown
 * (`core.messageCreatedAt(upToMessageId)`), clamped forward-only via
 * `GREATEST`/`LEAST`, and unread counts plus the "seen" ceiling depend on
 * that exact semantics. It never was, and must stay, the INSTANT the read
 * happened, so the frontend deliberately renders the Read row of the message
 * info sheet with no time (`features/messages/messageInfo.ts`).
 *
 * `last_read_instant` answers the different question those two columns were
 * being asked to answer at once: "when did this participant actually read".
 * It is written every `markRead` call to `now()` (the DB's own clock, matching
 * every other stamp `markRead` writes), UNCONDITIONALLY and ungated by the
 * PRD-364 read-receipt-sharing toggle, exactly like `last_read_at` itself
 * stays ungated at write time (the toggle only withholds `otherLastReadAt`/
 * `otherLastReadInstant` at RESPONSE time, via the same reciprocal
 * `viewerSharesReadReceipts && subjectSharesReadReceipts` check already
 * applied to `otherLastReadAt`). Read implies delivered but NOT the reverse,
 * so this is only ever advanced by `markRead`, never by `markDelivered`.
 *
 * Never GREATEST-clamped like `last_read_at`: the exact moment of the LATEST
 * `markRead` call is what "read" means here, whether that call landed a
 * watermark earlier or later than a previous one. A monotonic guard is
 * unnecessary because nothing downstream compares this column against a
 * message's own `created_at` the way `last_read_at` is compared.
 *
 * Nullable with no default and no backfill: every existing row starts NULL
 * ("never read since this column existed"), which the message info sheet
 * already renders as "no time" today, so nothing regresses.
 *
 * Single plain `ADD COLUMN` against an existing table with no new index.
 * Nothing filters on this column; it is only ever read back per-row.
 */
export class AddConversationParticipantLastReadInstant1820600000000 implements MigrationInterface {
  name = 'AddConversationParticipantLastReadInstant1820600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD COLUMN "last_read_instant" timestamptz NULL
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "last_read_instant"
    `);
  }
}
