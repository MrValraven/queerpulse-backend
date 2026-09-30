/**
 * Re-check cadence for connected feeds. Pure, so the backoff math is
 * unit-tested.
 */
const HOUR_MS = 60 * 60 * 1000;

/** A healthy feed is re-checked this long after each successful check. */
export const FEED_CHECK_INTERVAL_MS = 3 * HOUR_MS;
/** The longest a failing feed waits between attempts. */
export const FEED_MAX_BACKOFF_MS = 48 * HOUR_MS;
/** Consecutive failures at which a feed reads as `failing`. */
export const FEED_FAILING_THRESHOLD = 3;
/** The shortest gap between two manual syncs of one feed. */
export const MANUAL_SYNC_COOLDOWN_MS = 5 * 60 * 1000;
/** Feeds connected to one persona. */
export const MAX_FEEDS_PER_SUBPROFILE = 3;

/** Wait after the `consecutiveFailures`-th failure in a row:
 *  3 h * 2^(n-1), capped at 48 h (3, 6, 12, 24, 48, 48, ...). */
export function failureBackoffMs(consecutiveFailures: number): number {
  const exponent = Math.max(0, Math.floor(consecutiveFailures) - 1);
  // Past 2^5 the cap has long applied; clamping the exponent keeps the
  // arithmetic finite for any counter value.
  const backoff = FEED_CHECK_INTERVAL_MS * 2 ** Math.min(exponent, 10);
  return Math.min(backoff, FEED_MAX_BACKOFF_MS);
}

export function nextCheckAfterSuccess(now: Date): Date {
  return new Date(now.getTime() + FEED_CHECK_INTERVAL_MS);
}

export function nextCheckAfterFailure(
  now: Date,
  consecutiveFailures: number,
): Date {
  return new Date(now.getTime() + failureBackoffMs(consecutiveFailures));
}

export function feedStatus(consecutiveFailures: number): 'active' | 'failing' {
  return consecutiveFailures >= FEED_FAILING_THRESHOLD ? 'failing' : 'active';
}

/** Milliseconds until a manual sync is allowed again, or 0 when it is now. */
export function manualSyncWaitMs(
  lastAttemptAt: Date | null,
  now: Date,
): number {
  if (!lastAttemptAt) return 0;
  const elapsed = now.getTime() - lastAttemptAt.getTime();
  return elapsed >= MANUAL_SYNC_COOLDOWN_MS
    ? 0
    : MANUAL_SYNC_COOLDOWN_MS - Math.max(0, elapsed);
}
