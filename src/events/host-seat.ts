import type { EntityManager } from 'typeorm';

/**
 * THE HOST IS GOING. Seats `hostUserId` on `eventId` with a 'going' RSVP, the
 * one write every path that makes somebody a gathering's host goes through:
 * `EventsService.create` for a new gathering, and the erasure handover in
 * `ContentOwnerErasureService` when a co-host inherits one.
 *
 * The seat counts against capacity like any other. It is capacity-exempt on
 * the way in (a host is seated even on a full roster, and never waitlisted),
 * and `RsvpService` holds it from then on: the host cannot step down to
 * maybe, cancel it, or be removed from it. Nothing is announced: no
 * EVENT_RSVPED, no notification, no profile activity. The host knows.
 *
 * ONE STATEMENT, an upsert on `UQ_event_rsvps` (event_id, user_id):
 *  - no row yet: a fresh 'going' row with no guests, no waitlist position,
 *    and a NULL visibility, which reads as "everyone" (`EventRsvp.visibility`);
 *  - a row already there (a co-host who had RSVPed before inheriting the
 *    gathering, at any status): it becomes 'going' with no waitlist position
 *    and no host-removal stamp, and keeps everything its owner chose, their
 *    guest count, needs, answers and visibility included.
 *
 * THE HOUSE ACCOUNT IS NEVER SEATED. `users.is_system` marks the platform's
 * own non-human account (the genesis house account that hosts official
 * events). It is nobody at the door, so it takes no seat and never appears on
 * the roster. The filter lives in the statement itself, so a caller needs no
 * extra lookup, and a house-hosted gathering simply gets no row.
 *
 * Every identifier is a real snake_case column: this runs as raw SQL on
 * whichever manager the caller holds, so it joins the caller's transaction
 * when there is one.
 */
export async function seatHostAsGoing(
  manager: EntityManager,
  eventId: string,
  hostUserId: string,
): Promise<void> {
  await manager.query(
    `INSERT INTO "event_rsvps"
       ("event_id", "user_id", "status", "waitlist_position", "guest_count", "visibility")
     SELECT $1::uuid,
            "host"."id",
            'going'::"event_rsvps_status_enum",
            NULL,
            0,
            NULL
     FROM "users" AS "host"
     WHERE "host"."id" = $2::uuid
       AND "host"."is_system" = false
     ON CONFLICT ON CONSTRAINT "UQ_event_rsvps" DO UPDATE
       SET "status" = 'going'::"event_rsvps_status_enum",
           "waitlist_position" = NULL,
           "removed_by_host_at" = NULL,
           "updated_at" = now()`,
    [eventId, hostUserId],
  );
}
