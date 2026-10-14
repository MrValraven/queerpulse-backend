import {
  isWithinScheduleWindow,
  scheduleDateInLisbon,
} from './studio-schedule-rule';

const NOW = new Date('2026-10-13T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;

describe('isWithinScheduleWindow', () => {
  it.each([
    ['14 minutes ahead', 14 * MINUTE, false],
    ['15 minutes ahead', 15 * MINUTE, true],
    ['a week ahead', 7 * DAY, true],
    ['365 days ahead', 365 * DAY, true],
    ['365 days and a millisecond ahead', 365 * DAY + 1, false],
    ['an hour ago', -60 * MINUTE, false],
  ])('answers %s', (_label, leadMilliseconds, isAllowed) => {
    expect(
      isWithinScheduleWindow(new Date(NOW.getTime() + leadMilliseconds), NOW),
    ).toBe(isAllowed);
  });
});

describe('scheduleDateInLisbon', () => {
  it('reads a late UTC evening in summer time as the next Lisbon day', () => {
    expect(scheduleDateInLisbon(new Date('2026-10-20T23:30:00.000Z'))).toBe(
      '2026-10-21',
    );
  });

  it('reads the same UTC evening in winter time as the same day', () => {
    expect(scheduleDateInLisbon(new Date('2026-12-01T23:30:00.000Z'))).toBe(
      '2026-12-01',
    );
  });
});
