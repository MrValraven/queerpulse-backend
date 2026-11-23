// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * SEC-25: a group seat taken back after leaving or a removal keeps the
 * history it had up to the moment it left and gets none of what was posted
 * while it was away.
 *
 * Until now a re-seat moved `cleared_at` up to the old `left_at` and cleared
 * `left_at`. That hid the history the member had already read and opened up
 * everything posted during the absence, attachments included. Two scalar
 * boundaries cannot describe "before leaving, then after coming back", so
 * the seat gets a gap: `absence_started_at` (the old `left_at`) and
 * `absence_ended_at` (the re-seat instant). Every read skips a message
 * created inside that gap.
 *
 * One gap per seat, a known limit: a second leave and return raises
 * `cleared_at` to the end of the first gap and records the second one, so
 * the history from before the first absence drops out of view for that
 * member. That errs private.
 *
 * The backfill for seats re-seated under the old rule is a separate
 * migration (`1840811000000-BackfillConversationParticipantAbsenceGap`), so
 * this one only adds the columns and holds its table lock briefly. This
 * migration must run before the release that writes and reads the columns
 * is deployed. Rolling it back after any re-seat has written a gap drops
 * that gap, which reopens the absence to the member.
 *
 * No index: every predicate reads the two columns off a seat row it has
 * already joined by primary key or by `(conversation_id, user_id)`.
 */
export class AddConversationParticipantAbsenceGap1840810000000 implements MigrationInterface {
  name = 'AddConversationParticipantAbsenceGap1840810000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        ADD "absence_started_at" TIMESTAMP WITH TIME ZONE,
        ADD "absence_ended_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "conversation_participants"
        DROP COLUMN "absence_ended_at",
        DROP COLUMN "absence_started_at"
    `);
  }
}
