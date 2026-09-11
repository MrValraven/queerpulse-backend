import type { RecurrenceCadence } from './dto/recurrence.dto';
import {
  instantForWallClock,
  occurrenceStartAt,
  wallClockAt,
  zoneOffsetMilliseconds,
} from './series-occurrences';

/**
 * Every expectation below is an exact UTC instant and every zone is named, so
 * the spec reads the same on a laptop in Lisbon and in a UTC container.
 *
 * Lisbon's clocks change at 01:00 UTC on the last Sunday of March (01:00 local
 * jumps to 02:00) and of October (02:00 local falls back to 01:00). In 2026
 * those Sundays are 29 March and 25 October.
 */
const LISBON = 'Europe/Lisbon';
const NEW_YORK = 'America/New_York';
const HOUR_IN_MILLISECONDS = 60 * 60 * 1000;

const occurrenceStartsFor = (
  baseIso: string,
  cadence: RecurrenceCadence,
  count: number,
  timeZone: string,
): string[] =>
  Array.from({ length: count }, (_slot, index) =>
    occurrenceStartAt(
      new Date(baseIso),
      cadence,
      index,
      timeZone,
    ).toISOString(),
  );

describe('occurrenceStartAt', () => {
  it('keeps a weekly Lisbon series at 19:00 local across the October change', () => {
    expect(
      occurrenceStartsFor('2026-10-18T18:00:00.000Z', 'weekly', 3, LISBON),
    ).toEqual([
      '2026-10-18T18:00:00.000Z',
      '2026-10-25T19:00:00.000Z',
      '2026-11-01T19:00:00.000Z',
    ]);
  });

  it('keeps a monthly Lisbon series at 19:00 local across the March change', () => {
    expect(
      occurrenceStartsFor('2026-02-10T19:00:00.000Z', 'monthly', 3, LISBON),
    ).toEqual([
      '2026-02-10T19:00:00.000Z',
      '2026-03-10T19:00:00.000Z',
      '2026-04-10T18:00:00.000Z',
    ]);
  });

  it('steps a biweekly series fourteen calendar days at a time', () => {
    expect(
      occurrenceStartsFor('2026-10-11T18:00:00.000Z', 'biweekly', 2, LISBON),
    ).toEqual(['2026-10-11T18:00:00.000Z', '2026-10-25T19:00:00.000Z']);
  });

  it('holds a zone behind UTC to its own clock', () => {
    // New York leaves daylight time on 1 November 2026, so 19:00 local moves
    // from 23:00 UTC to midnight UTC the next calendar day.
    expect(
      occurrenceStartsFor('2026-10-25T23:00:00.000Z', 'weekly', 3, NEW_YORK),
    ).toEqual([
      '2026-10-25T23:00:00.000Z',
      '2026-11-02T00:00:00.000Z',
      '2026-11-09T00:00:00.000Z',
    ]);
  });

  it('rolls the 31st into the following month on a shorter one', () => {
    // 31 February 2027 normalises to 3 March, still winter time in Lisbon.
    expect(
      occurrenceStartsFor('2027-01-31T19:00:00.000Z', 'monthly', 2, LISBON),
    ).toEqual(['2027-01-31T19:00:00.000Z', '2027-03-03T19:00:00.000Z']);
  });

  it('keeps the seconds and milliseconds of the start', () => {
    expect(
      occurrenceStartsFor('2026-10-18T18:00:30.250Z', 'weekly', 2, LISBON),
    ).toEqual(['2026-10-18T18:00:30.250Z', '2026-10-25T19:00:30.250Z']);
  });

  it('lands a skipped wall time one hour later on the clock', () => {
    // 01:30 on 29 March 2026 does not exist in Lisbon. The offset from before
    // the gap (winter time) resolves it to 01:30 UTC, which the clock shows
    // as 02:30 summer time. The week after is an ordinary 01:30.
    const starts = occurrenceStartsFor(
      '2026-03-22T01:30:00.000Z',
      'weekly',
      3,
      LISBON,
    );
    expect(starts).toEqual([
      '2026-03-22T01:30:00.000Z',
      '2026-03-29T01:30:00.000Z',
      '2026-04-05T00:30:00.000Z',
    ]);
    const gapClock = wallClockAt(new Date(starts[1]!), LISBON);
    expect([gapClock.hour, gapClock.minute]).toEqual([2, 30]);
  });

  it('takes the earlier instant of a repeated wall time', () => {
    // 01:30 on 25 October 2026 happens twice in Lisbon: at 00:30 UTC in
    // summer time and at 01:30 UTC in winter time.
    expect(
      occurrenceStartsFor('2026-10-18T00:30:00.000Z', 'weekly', 2, LISBON),
    ).toEqual(['2026-10-18T00:30:00.000Z', '2026-10-25T00:30:00.000Z']);
  });
});

describe('instantForWallClock', () => {
  const wallClock = (
    year: number,
    month: number,
    day: number,
    hour: number,
    minute: number,
  ) => ({ year, month, day, hour, minute, second: 0, millisecond: 0 });

  it('reads an ordinary wall time in summer and in winter', () => {
    expect(
      instantForWallClock(wallClock(2026, 6, 1, 19, 0), LISBON).toISOString(),
    ).toBe('2026-07-01T18:00:00.000Z');
    expect(
      instantForWallClock(wallClock(2026, 11, 1, 19, 0), LISBON).toISOString(),
    ).toBe('2026-12-01T19:00:00.000Z');
  });

  it('uses the offset from before a spring-forward gap', () => {
    expect(
      instantForWallClock(wallClock(2026, 2, 29, 1, 30), LISBON).toISOString(),
    ).toBe('2026-03-29T01:30:00.000Z');
  });

  it('picks the first of the two instants a fall-back hour names', () => {
    expect(
      instantForWallClock(wallClock(2026, 9, 25, 1, 30), LISBON).toISOString(),
    ).toBe('2026-10-25T00:30:00.000Z');
  });
});

describe('wallClockAt and zoneOffsetMilliseconds', () => {
  it('reads midnight as hour zero of the next day', () => {
    const clock = wallClockAt(new Date('2026-07-01T23:00:00.000Z'), LISBON);
    expect(clock).toEqual({
      year: 2026,
      month: 6,
      day: 2,
      hour: 0,
      minute: 0,
      second: 0,
      millisecond: 0,
    });
  });

  it('measures the offset in whole seconds whatever the milliseconds', () => {
    expect(
      zoneOffsetMilliseconds(new Date('2026-07-01T12:00:00.500Z'), LISBON),
    ).toBe(HOUR_IN_MILLISECONDS);
    expect(
      zoneOffsetMilliseconds(new Date('2026-07-01T12:00:00.500Z'), NEW_YORK),
    ).toBe(-4 * HOUR_IN_MILLISECONDS);
  });
});
