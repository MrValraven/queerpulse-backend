import {
  FEED_CHECK_INTERVAL_MS,
  FEED_MAX_BACKOFF_MS,
  failureBackoffMs,
  feedStatus,
  manualSyncWaitMs,
  nextCheckAfterFailure,
  nextCheckAfterSuccess,
} from './feed-schedule';

const HOUR = 60 * 60 * 1000;

describe('feed schedule', () => {
  it('re-checks a healthy feed three hours later', () => {
    const now = new Date('2026-09-30T12:00:00Z');
    expect(nextCheckAfterSuccess(now).getTime() - now.getTime()).toBe(
      FEED_CHECK_INTERVAL_MS,
    );
    expect(FEED_CHECK_INTERVAL_MS).toBe(3 * HOUR);
  });

  it.each([
    [1, 3],
    [2, 6],
    [3, 12],
    [4, 24],
    [5, 48],
    [6, 48],
    [50, 48],
    [100000, 48],
  ])('backs off %s consecutive failures to %s h', (failures, hours) => {
    expect(failureBackoffMs(failures)).toBe(hours * HOUR);
  });

  it('never goes below the normal cadence or above 48 h', () => {
    expect(failureBackoffMs(0)).toBe(3 * HOUR);
    expect(FEED_MAX_BACKOFF_MS).toBe(48 * HOUR);
    const now = new Date('2026-09-30T12:00:00Z');
    expect(nextCheckAfterFailure(now, 4).toISOString()).toBe(
      '2026-10-01T12:00:00.000Z',
    );
  });

  it('reads as failing from the third consecutive failure', () => {
    expect(feedStatus(0)).toBe('active');
    expect(feedStatus(2)).toBe('active');
    expect(feedStatus(3)).toBe('failing');
    expect(feedStatus(9)).toBe('failing');
  });

  it('allows a manual sync five minutes after the last attempt', () => {
    const now = new Date('2026-09-30T12:05:00Z');
    expect(manualSyncWaitMs(null, now)).toBe(0);
    expect(manualSyncWaitMs(new Date('2026-09-30T12:00:00Z'), now)).toBe(0);
    expect(manualSyncWaitMs(new Date('2026-09-30T12:04:00Z'), now)).toBe(
      4 * 60 * 1000,
    );
  });
});
