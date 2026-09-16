import { TokenBucketLimiter } from './ws-rate-limiter';

describe('TokenBucketLimiter.sweepIdle', () => {
  it('deletes a bucket that has fully refilled by the sweep time, so the next consume starts fresh', () => {
    const limiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 });
    const start = 1_000_000;
    // Spend one token, leaving 4 of 5. Fully refills 5 seconds later.
    expect(limiter.tryConsume('u1', start)).toBe(true);

    limiter.sweepIdle(start + 5_000);

    // A swept bucket behaves exactly like one that was never created: full
    // capacity is restored, confirmed here by draining every token again.
    for (let i = 0; i < 5; i++) {
      expect(limiter.tryConsume('u1', start + 5_000)).toBe(true);
    }
    expect(limiter.tryConsume('u1', start + 5_000)).toBe(false);
  });

  it('keeps a bucket that has not fully refilled by the sweep time', () => {
    const limiter = new TokenBucketLimiter({ capacity: 5, refillPerSecond: 1 });
    const start = 1_000_000;
    // Drain the bucket entirely.
    for (let i = 0; i < 5; i++) {
      limiter.tryConsume('u1', start);
    }
    expect(limiter.tryConsume('u1', start)).toBe(false);

    // Only 2 of the 5 seconds needed to refill have passed.
    limiter.sweepIdle(start + 2_000);

    // Still rate-limited: the sweep must not have deleted, and thereby
    // reset, a bucket that genuinely has not refilled yet.
    expect(limiter.tryConsume('u1', start + 2_000)).toBe(false);
  });

  it('sweeping a bucket that was already cleared is a no-op, and the key behaves like a fresh bucket', () => {
    const limiter = new TokenBucketLimiter({ capacity: 3, refillPerSecond: 1 });
    const start = 1_000_000;
    limiter.tryConsume('u1', start);
    limiter.clear('u1');

    expect(() => limiter.sweepIdle(start)).not.toThrow();

    // A cleared (deleted) key is indistinguishable from one that was never
    // created: full capacity is immediately available.
    for (let i = 0; i < 3; i++) {
      expect(limiter.tryConsume('u1', start)).toBe(true);
    }
    expect(limiter.tryConsume('u1', start)).toBe(false);
  });
});
