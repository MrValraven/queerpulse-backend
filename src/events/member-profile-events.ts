import type { EventSummary } from './event-response';

/*
 * A member profile's Events section (`GET /profiles/:slug/events`): the
 * events the member hosts or co-hosts. The read itself is
 * `EventsService.listForMemberProfile`; the pieces it shares with its specs
 * live here. Lineup entries and RSVPs never count: a profile lists what the
 * member runs, and attending stays the attendee's own business.
 */

/** How many upcoming (or underway) events one profile response carries. */
export const MEMBER_PROFILE_UPCOMING_LIMIT = 12;

/** How many ended events the closed "Past events" fold carries. */
export const MEMBER_PROFILE_PAST_LIMIT = 6;

/** The member's part in a listed event: its host, or one of its co-hosts. */
export type ProfileEventRole = 'host' | 'cohost';

/** One row of a profile's Events section: the `GET /events` card plus the
 *  member's part in it. */
export type ProfileEventCard = EventSummary & { role: ProfileEventRole };

/** `GET /profiles/:slug/events`. `upcoming` is soonest first and holds at
 *  most `MEMBER_PROFILE_UPCOMING_LIMIT` rows; `past` is latest first and
 *  holds at most `MEMBER_PROFILE_PAST_LIMIT`. */
export interface ProfileEventsResponse {
  upcoming: ProfileEventCard[];
  past: ProfileEventCard[];
}

/**
 * The member hosts the event, or holds a co-host row on it, under alias `e`
 * and bound to `:memberId`. A top-level `IN` over a `UNION` of the two id
 * sets, so each arm is its own index scan (`IDX_events_host_id`,
 * `IDX_event_cohosts_user_id`) and the outer match is a join on the events
 * primary key. An `OR` of the host column and an `EXISTS` leaves the
 * `EXISTS` as a per-row SubPlan, which scans every published event. The
 * inner aliases start with `member_`, so TypeORM's `e.` property rewrite
 * leaves them alone.
 */
export const HOSTED_OR_COHOSTED_BY_MEMBER_SQL = `e.id IN (
      SELECT "member_hosted_event"."id" FROM "events" "member_hosted_event"
       WHERE "member_hosted_event"."host_id" = :memberId
      UNION
      SELECT "member_cohosted_event"."event_id" FROM "event_cohosts" "member_cohosted_event"
       WHERE "member_cohosted_event"."user_id" = :memberId
    )`;

/**
 * The series fold key under alias `e`: a recurring series' id, or the event's
 * own id for a standalone event (`series_id` NULL), so every standalone event
 * is a group of one. `DISTINCT ON` this key keeps one occurrence per series.
 */
export const SERIES_FOLD_KEY_SQL = 'COALESCE(e.series_id, e.id)';

/** `'host'` when the member hosts the event; every other listed row
 *  reached the list through a co-host row, so it reads `'cohost'`. */
export function memberEventRole(
  event: { hostId: string | null },
  memberUserId: string,
): ProfileEventRole {
  return event.hostId === memberUserId ? 'host' : 'cohost';
}
