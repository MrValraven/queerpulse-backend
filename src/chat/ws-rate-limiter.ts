/**
 * Per-key token-bucket limiter for WebSocket events.
 *
 * The global HTTP `ThrottlerGuard` deliberately skips WS contexts, so the chat
 * gateway must enforce its own abuse limits. This is intentionally in-memory and
 * process-local (MVP, single instance) — mirror the presence swap-to-Redis note
 * when scaling past one node.
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
      this.buckets.set(key, { tokens: this.config.capacity - 1, updatedAt: now });
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

  /** Drop a key's bucket — call on disconnect to keep the map bounded. */
  clear(key: string): void {
    this.buckets.delete(key);
  }
}
