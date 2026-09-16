/**
 * Per-key token-bucket limiter for WebSocket events.
 *
 * The global HTTP `ThrottlerGuard` deliberately skips WS contexts, so the chat
 * gateway must enforce its own abuse limits. This is intentionally in-memory and
 * process-local (MVP, single instance) — mirror the presence swap-to-Redis note
 * when scaling past one node. On a second replica every budget here silently
 * doubles, which is why `ChatSingleInstanceGuard` asserts the assumption at
 * boot rather than leaving it to a comment.
 */
export interface RateLimitConfig {
  /** Maximum burst — the bucket's full capacity. */
  capacity: number;
  /** Sustained refill rate in tokens per second. */
  refillPerSecond: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(private readonly config: RateLimitConfig) {}

  /**
   * Attempt to spend one token for `key`. Returns true when a token was
   * available (request allowed), false when the bucket is empty (rate limited).
   */
  tryConsume(key: string, now: number = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) {
      this.buckets.set(key, {
        tokens: this.config.capacity - 1,
        updatedAt: now,
      });
      return true;
    }
    const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
    bucket.tokens = Math.min(
      this.config.capacity,
      bucket.tokens + elapsedSeconds * this.config.refillPerSecond,
    );
    bucket.updatedAt = now;
    if (bucket.tokens < 1) {
      return false;
    }
    bucket.tokens -= 1;
    return true;
  }

  /** Drop a key's bucket unconditionally. Not called from the gateway's
   *  disconnect path any more (ENG-211, see `sweepIdle`'s doc for why that
   *  was the rate limit's bypass); kept for callers, and tests, that need to
   *  reset a specific key outright. */
  clear(key: string): void {
    this.buckets.delete(key);
  }

  /**
   * Deletes every bucket that would have refilled to FULL capacity by `now`.
   * A bucket in that state behaves identically to one that was never
   * created (the next `tryConsume` starts it fresh either way), so removing
   * it changes nothing observable while keeping the map from growing without
   * bound across the process's lifetime (ENG-211).
   *
   * Deliberately NOT what the gateway used to do on a user's last
   * disconnect, which was to delete the bucket regardless of how many tokens
   * it actually held: that reset a bucket that was still MID-DRAIN, so a
   * client could exhaust it, disconnect, reconnect, and start over on a full
   * one. The rate limit only ever held for as long as a single socket
   * stayed connected. Sweeping only fully-refilled buckets closes that hole
   * while still bounding memory: call this periodically (the gateway does,
   * every `IDLE_BUCKET_SWEEP_INTERVAL_MS`), decoupled from any particular
   * connection lifecycle event.
   */
  sweepIdle(now: number = Date.now()): void {
    for (const [key, bucket] of this.buckets) {
      const elapsedSeconds = Math.max(0, now - bucket.updatedAt) / 1000;
      const refilledTokens =
        bucket.tokens + elapsedSeconds * this.config.refillPerSecond;
      if (refilledTokens >= this.config.capacity) {
        this.buckets.delete(key);
      }
    }
  }
}
