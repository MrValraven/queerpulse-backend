import { Injectable } from '@nestjs/common';

/**
 * A per-recipient, per-bucket rate limiter for the PUSH channel only.
 *
 * ---------------------------------------------------------------------------
 * STATUS: WIRED (PRD-512). Read this first.
 * ---------------------------------------------------------------------------
 * `NotificationsModule` provides and exports it, and its one caller is
 * `PushNotificationListener`, the only place in the codebase where a
 * notification push is sent. The listener calls `allowedRecipients` once per
 * notification batch, after quiet hours and before any per-type handler, with
 * the bucket `push-fatigue:<bundleKey>` (`bundleKeyFor`) and
 * `PUSH_FATIGUE_WINDOW_MS`. A type with no bundle key is never throttled.
 * The in-app row is written before that event fires, so the contract below
 * holds.
 *
 * ONE CALLER TRIED AND WAS REMOVED, which is worth recording because the
 * lesson is in the contract at the bottom of this comment.
 * `ModerationQueueAlertService` (TS-04) used it to thin the recipient list
 * before writing its queue-health alerts. That put it on the IN-APP write
 * rather than on the push, which this class's contract forbids, and the
 * consequence was exactly what the contract exists to prevent: a suppressed
 * call wrote no notification while the caller's own state row recorded one as
 * delivered, and the queue then went silent permanently. That service now
 * dedups on its own durable state row and does not call this class. See its
 * docstring for the full walkthrough.
 *
 * THE PROBLEM IT EXISTS FOR: a pile-on. Thirty members reporting one post in
 * ten minutes is thirty rows on the moderation queue and, without this, thirty
 * separate phone pushes to every moderator on duty. The in-app notification
 * stays one row per report (the queue is a list of reports, and collapsing
 * them in the bell would hide the volume that IS the signal); the push is what
 * gets throttled, because a push is an interruption and the second one adds
 * nothing the first did not already say.
 *
 * There was no coalescing or throttle primitive anywhere in the notification
 * layer before this, so it is deliberately the smallest thing that works: an
 * in-process map of `${recipient}:${bucket}` to the last time that recipient
 * was pushed for that bucket. Two consequences to know about:
 *
 *  1. It is PER PROCESS. Running two API instances behind a load balancer
 *     means up to one push per instance per window. That is a far smaller
 *     number than the pile-on it exists to stop, and moving the state into
 *     Postgres or Redis for it would be a heavier dependency than the problem
 *     justifies today.
 *  2. It is memory-only. A restart clears it, and the first report after a
 *     restart pushes. That is the safe direction to fail in: a moderator gets
 *     one extra push rather than silence during an emergency.
 *
 * THE CONTRACT, and it is not advisory: a caller that suppresses a push here
 * must still have written the in-app row first, so nothing is ever lost, only
 * quieted. Anything that can be LOST by being dropped (an in-app row, a state
 * transition, a record another decision is later read from) must not be
 * routed through this class.
 */
@Injectable()
export class NotificationPushThrottleService {
  /** `${userId}:${bucketKey}` to the epoch-ms of that recipient's last push. */
  private readonly lastPushAtByKey = new Map<string, number>();

  /**
   * The subset of `userIds` that may be pushed for `bucketKey` right now,
   * marking each returned recipient as pushed. A recipient already pushed for
   * the same bucket inside `windowMs` is dropped.
   *
   * Deliberately synchronous and side-effecting in one call: the caller sends
   * to exactly the recipients it gets back, so there is no window between
   * "may I?" and "I did" for a concurrent second report to slip through.
   */
  allowedRecipients(
    userIds: string[],
    bucketKey: string,
    windowMs: number,
    /**
     * PRD-512: a caller that mints one bucket per subject (the push fatigue
     * cap's `push-fatigue:<bundleKey>`) names the shared prefix here, so the
     * entries of every bucket in that family are pruned against `windowMs`,
     * the family's one window. Without it a subject asked about once was
     * never asked about again and its entries stayed in the map for good.
     */
    bucketFamilyPrefix?: string,
  ): string[] {
    const now = Date.now();
    this.pruneExpired(now, bucketKey, windowMs);
    if (bucketFamilyPrefix) {
      this.pruneExpiredFamily(now, bucketFamilyPrefix, windowMs);
    }
    const allowed: string[] = [];
    for (const userId of new Set(userIds)) {
      const key = `${userId}:${bucketKey}`;
      const lastPushAt = this.lastPushAtByKey.get(key);
      if (lastPushAt !== undefined && now - lastPushAt < windowMs) {
        continue;
      }
      this.lastPushAtByKey.set(key, now);
      allowed.push(userId);
    }
    return allowed;
  }

  /** How many (recipient, bucket) entries the map holds, so a caller or a
   *  spec can confirm the pruning keeps it bounded. */
  trackedEntryCount(): number {
    return this.lastPushAtByKey.size;
  }

  /**
   * PRD-512: drop the expired entries of EVERY bucket whose key starts with
   * `bucketFamilyPrefix`. Safe in the way `pruneExpired`'s scoping requires:
   * a family shares one window (its caller passes the same `windowMs` for
   * every bucket it mints), so no other caller's window is applied here.
   */
  private pruneExpiredFamily(
    now: number,
    bucketFamilyPrefix: string,
    windowMs: number,
  ): void {
    for (const [key, lastPushAt] of this.lastPushAtByKey) {
      if (!key.slice(key.indexOf(':') + 1).startsWith(bucketFamilyPrefix)) {
        continue;
      }
      if (now - lastPushAt >= windowMs) {
        this.lastPushAtByKey.delete(key);
      }
    }
  }

  /**
   * Drop entries for THIS bucket that can no longer suppress anything. The map
   * only ever holds one entry per (recipient, bucket), so this is small work
   * over a small map, and doing it inline keeps the service free of a
   * scheduler.
   *
   * SCOPED TO THE BUCKET, which it was not originally. The map is shared by
   * every caller, and `windowMs` belongs to whichever caller happens to be
   * asking; sweeping the WHOLE map against one caller's window means a
   * consumer with a short window silently evicts a consumer with a long one,
   * and the long-window caller then stops suppressing anything at all. That is
   * invisible with a single caller and a genuine bug the moment there are two,
   * so the fix belongs here rather than in a future caller's head. Entries for
   * other buckets are left alone; they are pruned when their own bucket is
   * next asked about, which is the only moment their window is known, or
   * when a caller names their family prefix.
   */
  private pruneExpired(now: number, bucketKey: string, windowMs: number): void {
    for (const [key, lastPushAt] of this.lastPushAtByKey) {
      // Split on the FIRST colon rather than matching a suffix: a recipient id
      // is a uuid and never contains one, while a bucket key may (the
      // `a:b`-shaped keys callers naturally reach for), so a suffix test would
      // let bucket `alert` prune bucket `queue:alert` under the wrong window,
      // a smaller copy of the very bug this scoping fixes.
      if (key.slice(key.indexOf(':') + 1) !== bucketKey) continue;
      if (now - lastPushAt >= windowMs) {
        this.lastPushAtByKey.delete(key);
      }
    }
  }
}
