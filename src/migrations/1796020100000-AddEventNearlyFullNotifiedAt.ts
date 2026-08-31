// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * `events.nearly_full_notified_at`: the at-most-once claim for the
 * "last few spots" alert (PRD-18).
 *
 * `EventCapacityAlertsService` runs on every RSVP that takes or frees a seat,
 * so without a stamp every RSVP past the threshold would re-alert the same
 * people. The claim is taken with a conditional UPDATE
 * (`WHERE nearly_full_notified_at IS NULL`), the same shape
 * `membership_cards.expiry_warning_sent_at` and
 * `deletion_request.final_warning_sent_at` use, so two concurrent RSVPs that
 * both cross the line cannot both send.
 *
 * Nullable with no default and no backfill, deliberately. NULL means "not
 * alerted", which is the correct state for every gathering that exists today:
 * stamping them would silence the first alert on rooms that are filling right
 * now. The service clears the stamp again whenever seats free up past the
 * threshold, so a gathering that fills, empties and fills again earns a second
 * alert instead of being silenced forever by the first.
 *
 * Separate from `AddEventNearlyFullNotificationType1796020000000`, which adds
 * the enum label and must run outside a transaction. This one is ordinary
 * transactional DDL.
 */
export class AddEventNearlyFullNotifiedAt1796020100000 implements MigrationInterface {
  name = 'AddEventNearlyFullNotifiedAt1796020100000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD COLUMN "nearly_full_notified_at" TIMESTAMP WITH TIME ZONE`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "nearly_full_notified_at"`,
    );
  }
}
