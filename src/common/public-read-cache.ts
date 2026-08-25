/**
 * The cache headers every caller-agnostic public GET should carry.
 *
 * These exist as a PAIR because browsers and shared caches need different
 * answers, and a single `Cache-Control` cannot give them one each.
 * AUDIT-2026-07-30.md §I asked for CDN caching on public reads, and the header
 * it introduced (`public, s-maxage=60, stale-while-revalidate=300`) delivered
 * that. What it also did, unintentionally, was hand the same stale window to
 * every visitor's own browser cache.
 *
 * `s-maxage` is scoped to shared caches, so a browser applies no freshness
 * window from it. `stale-while-revalidate` has no such scoping: a private cache
 * honours it too. The result was a read-your-own-writes failure. A member
 * posted a review on a listing, the frontend refetched the listing, and the
 * browser answered that refetch from the copy it had stored BEFORE the write,
 * firing the real request in the background. Their review appeared only on the
 * next page load. Reproduced and confirmed fixed in Chromium against both
 * header shapes; every write-then-read surface on a cached public page had the
 * same defect.
 */

/**
 * Browser-facing freshness. No stale window at all, so a member always sees the
 * effect of their own write immediately. Revalidating each time is cheap rather
 * than wasteful: these responses carry an ETag, so an unchanged payload answers
 * 304 with no body. Shared caches still read the 60s from `s-maxage` here, so
 * a CDN that ignores the header below loses nothing.
 */
export const PUBLIC_READ_CACHE = 'public, s-maxage=60';

/**
 * CDN-facing freshness, preserving exactly the behaviour the audit asked for:
 * 60s fresh, then one stale answer while it revalidates for up to 5 more
 * minutes. A CDN that understands `CDN-Cache-Control` reads this and ignores
 * the browser-facing header. Browsers ignore this one entirely, which is the
 * whole reason the two are stated separately.
 */
export const PUBLIC_READ_CDN_CACHE =
  'public, s-maxage=60, stale-while-revalidate=300';
