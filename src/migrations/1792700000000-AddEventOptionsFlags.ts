import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the two `events` flags behind the manage dashboard's "Options" toggle
 * list (`ManageSettingsTab`/`SettingsTab`, queerpulse FE — `GATHERING_SETTINGS`
 * in `manageGathering.data.ts`) that now have a real, enforced effect:
 *
 *  - `allow_waitlist` — when false, `RsvpService.rsvp()` rejects a 'going'
 *    RSVP at capacity (400) instead of enqueueing the member on a waitlist
 *    the host doesn't want to run.
 *  - `show_attendee_count` — when false, a non-organizer viewer's "spots"
 *    copy reads generically ("Open to all") instead of a real headcount —
 *    see `events.adapters.ts`'s `spotsLabel()` (FE).
 *
 * The other two toggles the mock `GATHERING_SETTINGS` list used to show
 * ("Allow questions", "Require approval") were REMOVED from the settings UI
 * rather than persisted: there is no Q&A feature and no RSVP-approval
 * workflow anywhere in this codebase for either to gate, so persisting a
 * flag that gates nothing would just be a slower-to-discover version of the
 * same fake-functional UI this migration is fixing. Both default `true`
 * (unlimited waitlist, counts shown) so every existing event's behavior is
 * unchanged until a host opts out.
 */
export class AddEventOptionsFlags1792700000000 implements MigrationInterface {
  name = 'AddEventOptionsFlags1792700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" ADD "allow_waitlist" boolean NOT NULL DEFAULT true`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" ADD "show_attendee_count" boolean NOT NULL DEFAULT true`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "show_attendee_count"`,
    );
    await queryRunner.query(
      `ALTER TABLE "events" DROP COLUMN "allow_waitlist"`,
    );
  }
}
