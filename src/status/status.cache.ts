/**
 * Cache headers for `GET /status`, stated as a PAIR for the reason
 * `src/common/public-read-cache.ts` explains at length: `stale-while-revalidate`
 * is NOT scoped to shared caches, so putting it in `Cache-Control` hands the
 * stale window to every visitor's own browser and breaks read-your-own-writes.
 * This endpoint has its own constants rather than reusing `PUBLIC_READ_CACHE`
 * because 60s is far too long to sit on an outage.
 *
 * BROWSER: `max-age=0` — always revalidate. It is stated explicitly (rather
 * than left to heuristic freshness) because the whole point of this page is
 * that the manual refresh button gives a member a genuinely current answer.
 * Revalidation is cheap: the payload is small and the response is served from
 * an in-process cache, so a refetch rarely touches Postgres at all.
 *
 * CDN: 15s fresh, then one stale answer for up to 60s more while it
 * revalidates. That stale window is the point — an outage is exactly when the
 * origin is least able to answer, and a CDN holding the last known payload for
 * a minute is better than a status page that times out.
 */
export const STATUS_BROWSER_CACHE = 'public, max-age=0, s-maxage=15';

export const STATUS_CDN_CACHE =
  'public, s-maxage=15, stale-while-revalidate=60';

/**
 * How long one computed payload is reused inside the process. Shorter than the
 * CDN window, so the CDN never serves something the origin considers stale, and
 * long enough that a thundering herd on the status page during an outage costs
 * one database ping every 10 seconds rather than one per request.
 */
export const STATUS_MEMO_TTL_MS = 10_000;
