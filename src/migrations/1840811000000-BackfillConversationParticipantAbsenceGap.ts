// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SEC-25 backfill, kept apart from
 * `1840810000000-AddConversationParticipantAbsenceGap` so that migration's
 * `ADD COLUMN` holds its table lock only briefly. Run both before the
 * release that reads the columns is deployed.
 *
 * A group seat re-seated under the old rule still has `cleared_at` at its
 * old `left_at`, and the stretch it was away for is open to the member. Its
 * re-seat is the earliest `member_added` pill naming the member as target,
 * or `member_joined` pill naming them as actor, created after `cleared_at`
 * and, for a seat that is away again right now, at or before its current
 * `left_at`. The gap runs from `cleared_at` to one millisecond before that
 * pill, the floor `readGroupJoinHistoryFloor` writes, so the pill itself
 * stays visible. A seat whose `history_floor_at` equals `cleared_at` is a
 * brand-new PRD-400 joiner and is skipped. The pre-leave history the old
 * rule already hid stays hidden, which errs private.
 *
 * `down` writes nothing: clearing these gaps would reopen every absence the
 * backfill closed. Rolling back the column migration after this one, or
 * after any re-seat, reopens them too.
 */
export class BackfillConversationParticipantAbsenceGap1840811000000 implements MigrationInterface {
  name = 'BackfillConversationParticipantAbsenceGap1840811000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "conversation_participants" "seat"
        SET "absence_started_at" = "seat"."cleared_at",
            "absence_ended_at" = "rejoin"."rejoined_at"
        FROM (
          SELECT "candidate"."id" AS "seat_id",
                 MIN(date_trunc('milliseconds', "pill"."created_at")
                   - interval '1 millisecond') AS "rejoined_at"
            FROM "conversation_participants" "candidate"
            JOIN "conversations" "seat_conversation"
              ON "seat_conversation"."id" = "candidate"."conversation_id"
             AND "seat_conversation"."kind" = 'group'
            JOIN "messages" "pill"
              ON "pill"."conversation_id" = "candidate"."conversation_id"
             AND "pill"."kind" = 'system'
             AND "pill"."created_at" > "candidate"."cleared_at"
             AND "pill"."created_at" <= COALESCE("candidate"."left_at", 'infinity')
             AND (
               ("pill"."system_event" ->> 'type' = 'member_added'
                 AND "pill"."system_event" ->> 'targetId' = "candidate"."user_id"::text)
               OR ("pill"."system_event" ->> 'type' = 'member_joined'
                 AND "pill"."system_event" ->> 'actorId' = "candidate"."user_id"::text)
             )
            WHERE "candidate"."cleared_at" IS NOT NULL
              AND "candidate"."absence_started_at" IS NULL
              AND ("candidate"."history_floor_at" IS NULL
                OR "candidate"."history_floor_at" <> "candidate"."cleared_at")
            GROUP BY "candidate"."id"
        ) "rejoin"
        WHERE "seat"."id" = "rejoin"."seat_id"
          AND "rejoin"."rejoined_at" > "seat"."cleared_at"
    `);
  }

  public async down(): Promise<void> {
    // Intentionally empty, see the class doc.
  }
}
