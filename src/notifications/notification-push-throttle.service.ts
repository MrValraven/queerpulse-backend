import { Injectable } from '@nestjs/common';

/**
 * A per-recipient, per-bucket rate limiter for the PUSH channel only.
 *
 * The problem it exists for: a pile-on. Thirty members reporting one post in
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
 * A caller that suppresses a push here must still have written the in-app row
 * first, so nothing is ever lost, only quieted.
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
  ): string[] {
    const now = Date.now();
    this.pruneExpired(now, windowMs);
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

  /**
   * Drop entries that can no longer suppress anything. The map only ever holds
   * one entry per (staff member, bucket), so this is small work over a small
   * map, and doing it inline keeps the service free of a scheduler.
   */
  private pruneExpired(now: number, windowMs: number): void {
    for (const [key, lastPushAt] of this.lastPushAtByKey) {
      if (now - lastPushAt >= windowMs) {
        this.lastPushAtByKey.delete(key);
      }
    }
  }
}
