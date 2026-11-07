// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Seats the current QueerPulse Team staff in every official thread whose
 * member replied before the mailbox shipped (2026-10-05).
 *
 * A staff seat in an official thread is created when the member replies
 * (`OfficialMailboxSeatsService.seatStaffForMemberReply`), and the hourly
 * sweep (`IdentityMailboxSyncService.resyncMailbox`) only reconciles threads
 * that already hold at least one seat under the official identity. A member
 * who replied before the mailbox existed therefore sits in a thread with no
 * staff seat, and no later code path ever brings that thread into the mailbox.
 * `AddOfficialMailboxIdentity1827900100000` created the identity without
 * seating anyone. This migration does the one-time backfill.
 *
 * 1. Every official thread whose member has written at least one message that
 *    is still visible gets a seat for each current staff user (active,
 *    non-system, role admin or moderator, the filter `officialStaff()` in
 *    `IdentitiesService` applies). A user who already has a seat in the thread,
 *    under any identity, is skipped, because there is one seat per
 *    (conversation, user) and a staff member who is the thread's own member
 *    keeps their member seat. The seat values match `resyncConversation` with
 *    `shouldSeatWithFullHistory`: the official identity, and no cleared,
 *    history floor or left timestamp, so whoever answers for the platform
 *    reads what the platform already said in the thread.
 * 2. A staff seat under the official identity that carries `left_at` in such a
 *    thread, for a user who is staff now, is reactivated the way the
 *    `seat.leftAt` branch of `resyncConversation` does it, with `left_at`,
 *    `cleared_at` and `history_floor_at` all null.
 *
 * Both statements select nothing when the official identity row is missing.
 * Bounded by the official threads with a member reply times the number of
 * staff users.
 */
export class SeatOfficialStaffInRepliedThreads1839900000000 implements MigrationInterface {
  name = 'SeatOfficialStaffInRepliedThreads1839900000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      INSERT INTO "conversation_participants"
        ("conversation_id", "user_id", "identity_id", "cleared_at", "history_floor_at", "left_at")
      SELECT conversation."id", staff."id", official."id", NULL, NULL, NULL
      FROM "identities" official
      CROSS JOIN "conversations" conversation
      CROSS JOIN "users" staff
      WHERE official."kind" = 'official'
        AND conversation."is_official" = true
        AND staff."role" IN ('admin', 'moderator')
        AND staff."status" = 'active'
        AND staff."is_system" = false
        AND EXISTS (
          SELECT 1
          FROM "messages" member_message
          WHERE member_message."conversation_id" = conversation."id"
            AND member_message."sender_id" = conversation."official_member_id"
            AND member_message."deleted_at" IS NULL
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "conversation_participants" existing_seat
          WHERE existing_seat."conversation_id" = conversation."id"
            AND existing_seat."user_id" = staff."id"
        )
      ON CONFLICT ("conversation_id", "user_id") DO NOTHING
    `);
    await queryRunner.query(`
      UPDATE "conversation_participants" seat
      SET "left_at" = NULL, "cleared_at" = NULL, "history_floor_at" = NULL
      FROM "identities" official, "conversations" conversation, "users" staff
      WHERE official."kind" = 'official'
        AND seat."identity_id" = official."id"
        AND seat."left_at" IS NOT NULL
        AND conversation."id" = seat."conversation_id"
        AND conversation."is_official" = true
        AND staff."id" = seat."user_id"
        AND staff."role" IN ('admin', 'moderator')
        AND staff."status" = 'active'
        AND staff."is_system" = false
        AND EXISTS (
          SELECT 1
          FROM "messages" member_message
          WHERE member_message."conversation_id" = conversation."id"
            AND member_message."sender_id" = conversation."official_member_id"
            AND member_message."deleted_at" IS NULL
        )
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. A seat written here looks the same as a seat made
    // by a later live member reply, so deleting by shape would also remove
    // seats that were never part of this backfill. The hourly sweep keeps the
    // official seats correct from here on, which is why the seats stay.
  }
}
