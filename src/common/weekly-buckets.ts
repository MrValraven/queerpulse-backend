/**
 * Generic weekly-bucket helpers for any admin read model that stacks
 * time-series data into fixed-length weekly buckets, oldest first. Extracted
 * from `AdminOverviewService`'s own `buildEmptyWeeklyBuckets`/
 * `weekBucketIndex` pair (still private there, unchanged, backing the
 * Overview dashboard's fixed 8/10-week windows) so `AdminReportsService` can
 * build the SAME kind of buckets for a caller-supplied week count, without
 * duplicating the bucketing math for the ADM-17 adjustable date range.
 */
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

export interface WeeklyBucket<BucketValue> {
  weekStartMs: number;
  value: BucketValue;
}

/** `weekCount` empty buckets, oldest first, each stamped with the epoch ms
 *  its 7-day window opens — `weekBucketIndex` maps a timestamp to the
 *  matching position in the SAME array. */
export function buildEmptyWeeklyBuckets<BucketValue>(
  now: Date,
  weekCount: number,
  makeEmptyValue: () => BucketValue,
): WeeklyBucket<BucketValue>[] {
  const buckets: WeeklyBucket<BucketValue>[] = [];
  // Iterating from the oldest week (weeksAgo = weekCount) down to the newest
  // (weeksAgo = 1) builds the array already in the oldest-first order the
  // DTOs require — no separate reverse step.
  for (let weeksAgo = weekCount; weeksAgo >= 1; weeksAgo -= 1) {
    buckets.push({
      weekStartMs: now.getTime() - weeksAgo * WEEK_MS,
      value: makeEmptyValue(),
    });
  }
  return buckets;
}

/** Maps `occurredAt` to its position in a `buildEmptyWeeklyBuckets(now,
 *  weekCount, ...)` array, or `null` if it falls outside the window entirely
 *  (older than `weekCount` weeks, or somehow in the future). */
export function weekBucketIndex(
  now: Date,
  occurredAt: Date,
  weekCount: number,
): number | null {
  const weeksAgoFromNewest = Math.floor(
    (now.getTime() - occurredAt.getTime()) / WEEK_MS,
  );
  if (weeksAgoFromNewest < 0 || weeksAgoFromNewest >= weekCount) return null;
  return weekCount - 1 - weeksAgoFromNewest;
}
