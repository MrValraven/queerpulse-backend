// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The columns behind LOC-04, LOC-18, LOC-03 and half of LOC-08 — everything
 * that hangs off an existing `events` or `event_rsvps` row. The two new tables
 * (`event_announcements`, `event_bans`) and the discovery indexes land in
 * `CreateEventAnnouncementsAndBans1794701000000`.
 *
 * ── `events`: where it actually is (LOC-04) ────────────────────────────────
 * The create-gathering wizard has always asked for a street address, arrival
 * directions, a neighbourhood, a language, a gathering type, five
 * accessibility checkboxes and an accessibility note, and then made the host
 * tick "the accessibility information I have given is accurate" before
 * publishing. None of it had a column. Only a 300-character venue name
 * survived the submit, so a house party or a pop-up was unfindable, a
 * wheelchair user could not learn whether they could get in, and the platform
 * extracted a truthfulness pledge about data it deleted on the way to the
 * database.
 *
 * `accessibility_answers` is the SAME `jsonb` three-valued map business
 * listings carry (`listings.accessibility_answers`, and the vocabulary in
 * `listings/listing-accessibility.ts`), deliberately reused rather than
 * forked: "unknown" has to stay a different fact from "no" in both places, and
 * a second vocabulary is a second vocabulary to disagree with the first.
 * Existing rows default to `'{}'` and the service normalizes on read, so every
 * response carries a complete six-question map whatever the row was written
 * with.
 *
 * `address` and `arrival_notes` are the exact door and are withheld from
 * anyone without a confirmed 'going' RSVP by the response mapper, the same way
 * `toHousingListingDTO` withholds a home's precise point. Nothing in this
 * migration enforces that: the gate lives in `EventsService.buildDetail`,
 * where every other visibility rule for an event already lives.
 *
 * ── `events.cost` (LOC-18) ─────────────────────────────────────────────────
 * FREE TEXT, mirroring `listings.price`'s reasoning exactly: real door pricing
 * is "5 to 15 EUR sliding scale", "pay what you can at the door", "free". A
 * numeric column would force every one of those into a lie or an empty cell.
 * DISPLAY ONLY. There is no payment integration on this platform and this
 * column is not the beginning of one.
 *
 * ── `event_rsvps.checked_in_at` (LOC-03) ───────────────────────────────────
 * The day-of dashboard was a mock: no check-in column existed anywhere, so a
 * host at their own door was tapping names that flipped local state and
 * toasted success. This is where an arrival is actually recorded.
 *
 * ── `event_rsvps.removed_by_host_at` (LOC-08) ──────────────────────────────
 * `status = 'cancelled'` meant two different things — "the member changed
 * their mind" and "the host removed them" — and `RsvpService.rsvp` read both
 * as a first RSVP, so a removed attendee walked straight back onto the roster
 * by pressing the button again. This column is the difference. It is nullable
 * with no default: every existing cancelled row is treated as a
 * self-cancellation, which is the safe direction to be wrong in (nobody is
 * retroactively barred from a gathering they left of their own accord).
 *
 * No index on either new `event_rsvps` column: both are read only alongside an
 * `event_id` (or `event_id, user_id`) predicate that the existing
 * `IDX_event_rsvps_status_order` / `UQ_event_rsvps` already serve.
 */
export class AddEventLocationAccessCostAndCheckIn1794700000000 implements MigrationInterface {
  name = 'AddEventLocationAccessCostAndCheckIn1794700000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "events"
        ADD COLUMN "address" character varying(300),
        ADD COLUMN "arrival_notes" character varying(500),
        ADD COLUMN "neighbourhood" character varying(120),
        ADD COLUMN "language" character varying(80),
        ADD COLUMN "event_type" character varying(80),
        ADD COLUMN "accessibility_answers" jsonb NOT NULL DEFAULT '{}',
        ADD COLUMN "accessibility_note" text NOT NULL DEFAULT '',
        ADD COLUMN "cost" character varying(120)
    `);

    await queryRunner.query(`
      ALTER TABLE "event_rsvps"
        ADD COLUMN "checked_in_at" TIMESTAMP WITH TIME ZONE,
        ADD COLUMN "removed_by_host_at" TIMESTAMP WITH TIME ZONE
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TABLE "event_rsvps"
        DROP COLUMN "removed_by_host_at",
        DROP COLUMN "checked_in_at"
    `);
    await queryRunner.query(`
      ALTER TABLE "events"
        DROP COLUMN "cost",
        DROP COLUMN "accessibility_note",
        DROP COLUMN "accessibility_answers",
        DROP COLUMN "event_type",
        DROP COLUMN "language",
        DROP COLUMN "neighbourhood",
        DROP COLUMN "arrival_notes",
        DROP COLUMN "address"
    `);
  }
}
