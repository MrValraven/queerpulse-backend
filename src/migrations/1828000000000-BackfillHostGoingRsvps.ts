// DO NOT RUN: authored for review only; the maintainer runs migrations.
import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * The host is going to their own gathering.
 *
 * `EventsService.create` now saves a real 'going' `event_rsvps` row for the
 * host on every occurrence it writes (`seatHostAsGoing`), so the host counts toward capacity (a
 * gathering for five has four spots left for guests) and every existing
 * count, roster, reminder and capacity alert reads them with no special case.
 * `RsvpService` keeps that seat held: the host cannot step down to maybe,
 * cancel it, or be removed from it.
 *
 * This backfills the same invariant onto gatherings created before that
 * change, in two statements:
 *
 *  1. A host who already holds a row on their own gathering at some other
 *     status (maybe, waitlisted, or cancelled, including a removal a co-host
 *     made) is moved to 'going', with no waitlist position and no removal
 *     stamp, the same shape `RsvpService.rsvp` gives a host pressing going.
 *  2. A host with no row at all gets one: 'going', no guests, no waitlist
 *     position, and a NULL visibility, which reads as "everyone". The
 *     `UQ_event_rsvps` (event_id, user_id) constraint makes it a no-op for
 *     every host statement 1 already covered.
 *
 * SCOPE. Only gatherings that are still ahead or under way, and not
 * cancelled. `COALESCE(end_at, start_at) > now()` reads the stated end when
 * there is one and the start otherwise, the same line `hasEnded` in
 * `event-timing.ts` draws. Past gatherings are left alone: a host row written
 * now onto a night that is over would claim an attendance nobody recorded,
 * and would feed history-reading counts (the 'past' list, the public-profile
 * participation signal) with rows that never existed at the time. A gathering
 * whose host erased their account has a NULL `host_id` and is skipped by the
 * `IS NOT NULL` guard. Drafts are included, since `create` seats the host on
 * a draft too, and publishing one later should find the host already going.
 *
 * THE HOUSE ACCOUNT IS NEVER SEATED. A gathering hosted by `users.is_system`
 * (the platform's own non-human account, which hosts official events) is
 * skipped by both statements, matching `seatHostAsGoing` in
 * `src/events/host-seat.ts`. `is_system` is the stable marker for it: set by
 * `AddUserIsSystem1782800840000` and on creation by genesis, independent of
 * any runtime config.
 *
 * CAPACITY. A gathering that is already full gains its host as one seat over
 * capacity. Nothing is bumped to make room: `RsvpService` reads a full
 * roster as full and promotes nobody from the waitlist until enough seats
 * come free, so the overshoot corrects itself as guests leave.
 *
 * Purely data, no DDL, and set-based: each statement is a single pass over
 * `events` joined through the existing `IDX_event_rsvps_event_id` index and
 * the `UQ_event_rsvps` unique index.
 */
export class BackfillHostGoingRsvps1828000000000 implements MigrationInterface {
  name = 'BackfillHostGoingRsvps1828000000000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      UPDATE "event_rsvps" AS "rsvp"
      SET "status" = 'going',
          "waitlist_position" = NULL,
          "removed_by_host_at" = NULL,
          "updated_at" = now()
      FROM "events" AS "event"
      JOIN "users" AS "host" ON "host"."id" = "event"."host_id"
      WHERE "rsvp"."event_id" = "event"."id"
        AND "rsvp"."user_id" = "event"."host_id"
        AND "rsvp"."status" <> 'going'
        AND "host"."is_system" = false
        AND "event"."host_id" IS NOT NULL
        AND "event"."status" <> 'cancelled'
        AND COALESCE("event"."end_at", "event"."start_at") > now()
    `);
    await queryRunner.query(`
      INSERT INTO "event_rsvps"
        ("event_id", "user_id", "status", "waitlist_position", "guest_count", "visibility")
      SELECT "event"."id",
             "event"."host_id",
             'going'::"event_rsvps_status_enum",
             NULL,
             0,
             NULL
      FROM "events" AS "event"
      JOIN "users" AS "host" ON "host"."id" = "event"."host_id"
      WHERE "event"."host_id" IS NOT NULL
        AND "host"."is_system" = false
        AND "event"."status" <> 'cancelled'
        AND COALESCE("event"."end_at", "event"."start_at") > now()
      ON CONFLICT ON CONSTRAINT "UQ_event_rsvps" DO NOTHING
    `);
  }

  public async down(): Promise<void> {
    // Deliberately a no-op. A backfilled host row is indistinguishable from
    // one the host made by pressing going themselves, before or after this
    // migration, and from one `EventsService.create` has written since. So is
    // a row statement 1 moved to 'going' from whatever it held before, since
    // the earlier status was not recorded anywhere. Deleting or reverting
    // host rows here would take real RSVPs off live gatherings, and the code
    // this migration supports expects every host to hold that seat anyway.
  }
}
