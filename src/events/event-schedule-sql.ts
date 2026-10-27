/*
 * The two schedule predicates every event list shares, under alias `e` and
 * bound to `:now`. Spelled once here so browse (`EventsService.list`), a
 * community's own lane (`listUpcomingByCommunity`) and a member profile's
 * Events section (`listForMemberProfile`) all split time the same way.
 */

/**
 * Upcoming or underway: an event counts until it has both started and ended,
 * so an overnight night out or a three-day festival stays listed while it
 * runs. `EventsService.list`'s 'upcoming' branch explains why the disjunct is
 * written this way and what it costs in index terms.
 */
export const UPCOMING_OR_UNDERWAY_SQL =
  '(e.start_at >= :now OR (e.end_at IS NOT NULL AND e.end_at >= :now))';

/**
 * Ended: the exact logical inverse of `UPCOMING_OR_UNDERWAY_SQL`, so no
 * instant reads as both. The null-end arm matches `hasEnded`'s strict
 * reading in `event-timing.ts`.
 */
export const ENDED_SQL =
  '(e.start_at < :now AND (e.end_at IS NULL OR e.end_at < :now))';
