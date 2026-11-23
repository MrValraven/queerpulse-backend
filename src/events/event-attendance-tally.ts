/**
 * The events attended tally (community badges contract section 12).
 *
 * `community_members.events_attended_count` is a bare per-community count of
 * the events a member was checked in at. It outlives the 30-day erasure of
 * `event_rsvps.checked_in_at`, so community badges can keep counting
 * attendance after the retention sweep. The tally holds no event id and no
 * date. Each statement joins the event to its own community's roster: a guest
 * off the community's roster, or an event with no community, matches no row
 * and counts nothing. A guest checked in before joining the community who is
 * then undone after joining loses one from the count, floored at zero.
 */

/**
 * Adds one to the member's tally in the event's community, after a check-in
 * that changed state. Parameters: `[eventId, userId]`.
 */
export const INCREMENT_EVENTS_ATTENDED_SQL = `
  UPDATE "community_members" "m"
  SET "events_attended_count" = "m"."events_attended_count" + 1
  FROM "events" "e"
  WHERE "e"."id" = $1 AND "m"."community_id" = "e"."community_id" AND "m"."user_id" = $2
`;

/**
 * Takes one off the member's tally in the event's community, floored at zero,
 * after a host undo that changed state. Parameters: `[eventId, userId]`.
 */
export const DECREMENT_EVENTS_ATTENDED_SQL = `
  UPDATE "community_members" "m"
  SET "events_attended_count" = GREATEST("m"."events_attended_count" - 1, 0)
  FROM "events" "e"
  WHERE "e"."id" = $1 AND "m"."community_id" = "e"."community_id" AND "m"."user_id" = $2
`;
