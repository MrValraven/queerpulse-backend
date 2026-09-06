/**
 * Frontend paths for a gathering, in one place.
 *
 * Every deep link this backend hands out — a reminder push, a cancellation
 * push, the `URL:` line of a subscribed `.ics` feed — has to resolve in the
 * SPA's own router. It did not: three call sites each built `/events/<slug>`
 * by hand, and the frontend routes the detail page at `/gatherings/<slug>`
 * (`queerpulse/src/features/gatherings/routes.tsx`). `/events` is the hub
 * (the board), and it has no `:slug` child, so every reminder and every
 * cancellation notice landed a member on the 404 page, as did the calendar
 * entry when opened from Google or Apple Calendar (PRD-180).
 *
 * These two constants are the contract with `routeMap.ts` on the frontend:
 * `routes.gatherings` + `gatheringPath()` there, `GATHERINGS_BOARD_PATH` +
 * `gatheringPath()` here. Changing a path on one side means changing it on
 * the other, which is exactly why neither side should spell it inline again.
 */

/** The gatherings board (`EventsPage`) — the fallback when there is no slug. */
export const GATHERINGS_BOARD_PATH = '/events';

/** One gathering's detail page. Mirrors `gatheringPath` in `routeMap.ts`. */
export function gatheringPath(slug: string): string {
  return `/gatherings/${slug}`;
}
