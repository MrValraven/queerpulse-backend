// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Gives a mailbox staff seat a history floor of its own, apart from
 * `cleared_at`.
 *
 * Until now the staff privacy floor WAS the seat's `cleared_at`, read
 * through `mailboxStaffHistoryFloorCoversPredicate` for a business, persona
 * or company seat in a direct, non-official thread. Hiring or rehiring a
 * staff member wrote `cleared_at`, and so did that person's own "clear
 * chat". A personal clear on a staff seat therefore became a hard privacy
 * floor: quotes, pins, reactions, stars, downloads, forwards, live edit
 * frames and reports on older messages all stopped working for them.
 *
 * `history_floor_at` is the floor. The hire, rehire and single-thread
 * resync paths write it together with `cleared_at`, from the same database
 * instant, so plain readers keep hiding pre-hire history from the list. A
 * personal clear writes `cleared_at` alone and hides history from that
 * person's own message list, exactly as it does in a personal chat.
 *
 * The backfill copies `cleared_at` into the new column for every seat the
 * current predicate treats as floored: a set `cleared_at`, an identity whose
 * kind is not `profile`, and a conversation that is neither a group nor
 * official. Every privacy floor that exists today survives. A staff member
 * who cleared a thread for themselves before this migration keeps that
 * clear as a floor on the rows it already covers, which errs private.
 * Seats the previous release creates while this runs pre-deploy miss the
 * backfill; the business mailboxes handover (section 2, "After the deploy")
 * gives the one-shot statement to run once the new release is live.
 *
 * No index: the predicate reads the column off a seat row it has already
 * joined by primary key or by `(conversation_id, user_id)`, and nothing
 * filters or sorts by it.
 */
export class AddConversationParticipantHistoryFloor1821500000000 implements MigrationInterface {
  name = 'AddConversationParticipantHistoryFloor1821500000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD "history_floor_at" TIMESTAMP WITH TIME ZONE
    `);
    await queryRunner.query(`
      UPDATE "conversation_participants" "seat"
        SET "history_floor_at" = "seat"."cleared_at"
        FROM "identities" "seat_identity", "conversations" "seat_conversation"
        WHERE "seat"."cleared_at" IS NOT NULL
          AND "seat_identity"."id" = "seat"."identity_id"
          AND "seat_identity"."kind" <> 'profile'
          AND "seat_conversation"."id" = "seat"."conversation_id"
          AND "seat_conversation"."kind" <> 'group'
          AND "seat_conversation"."is_official" = false
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "history_floor_at"
    `);
  }
}
