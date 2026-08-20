import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Adds the four fields `RsvpDetailsModal` (queerpulse FE, MyEvents "Anything
 * we should know?" editor) collects but never persisted: guest count, access
 * needs, dietary needs, and who can see this attendee's RSVP details. The
 * modal previously toasted "Preferences saved" unconditionally while
 * discarding every value on close — a real gap for the accessibility/dietary
 * disclosure a queer-community events platform should take seriously.
 *
 * `visibility` is a plain varchar (not a Postgres enum), mirroring
 * `MemberEventReminderPreferences.defaultEventVisibility`'s precedent: the
 * closed set (`everyone` / `connections` / `justMe` — the same three ids the
 * FE's `RsvpDetailsModal` already uses) is guarded by the DTO's `@IsIn`, so a
 * future option doesn't need a type migration. `guest_count` defaults to 0 so
 * every existing RSVP reads as "no guest" rather than null; the two free-text
 * fields are nullable (no value entered = no disclosure, not an empty string).
 */
export class AddEventRsvpDetails1792600000000 implements MigrationInterface {
  name = 'AddEventRsvpDetails1792600000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" ADD "guest_count" integer NOT NULL DEFAULT 0`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" ADD "access_needs" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" ADD "dietary_needs" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" ADD "visibility" character varying(20)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" DROP COLUMN "visibility"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" DROP COLUMN "dietary_needs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" DROP COLUMN "access_needs"`,
    );
    await queryRunner.query(
      `ALTER TABLE "event_rsvps" DROP COLUMN "guest_count"`,
    );
  }
}
