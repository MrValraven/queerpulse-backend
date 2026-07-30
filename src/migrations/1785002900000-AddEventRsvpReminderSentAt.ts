// DO NOT RUN — authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Per-attendee reminder claim column. Different attendees of one event can have
 * different reminder lead times, so "already reminded" moves from the single
 * `events.reminder_sent_at` (now legacy/unused) to per-RSVP here. Null = not yet
 * reminded; the sweep stamps it under a conditional UPDATE (at-most-once).
 */
export class AddEventRsvpReminderSentAt1785002900000 implements MigrationInterface {
  name = 'AddEventRsvpReminderSentAt1785002900000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" ADD "reminder_sent_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" DROP COLUMN "reminder_sent_at"`,
    );
  }
}
