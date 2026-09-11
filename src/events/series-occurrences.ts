import type { RecurrenceCadence } from './dto/recurrence.dto';

/**
 * Stepping a series on the gathering's own wall clock.
 *
 * A weekly supper at 19:00 in Lisbon is at 19:00 in Lisbon every week,
 * including the week the clocks change. Stepping the instant by a fixed number
 * of days in the process zone (UTC in the container) kept the elapsed gap and
 * moved the local time instead, so every occurrence after 25 October read
 * 20:00 on the page. These helpers read the start's wall clock in the event's
 * IANA zone, step the calendar fields there, and turn the stepped wall clock
 * back into an instant.
 *
 * `Intl` only: the zone database inside Node's full ICU already knows every
 * transition, so no date library is needed. Nothing here reads the process
 * zone, which is what lets the spec pin exact instants on any machine.
 */

/** A calendar date and time of day as read on a clock in some zone. Months
 *  are zero-based, matching `Date.UTC`. */
export interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const MILLISECONDS_PER_SECOND = 1000;
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

// Building a formatter is the slow part of `Intl`, and a 52-week series asks
// the same zone a few hundred times, so each zone keeps one.
const wallClockFormatters = new Map<string, Intl.DateTimeFormat>();

function wallClockFormatter(timeZone: string): Intl.DateTimeFormat {
  const cached = wallClockFormatters.get(timeZone);
  if (cached) return cached;
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
    hourCycle: 'h23',
  });
  wallClockFormatters.set(timeZone, formatter);
  return formatter;
}

/** What a clock in `timeZone` reads at `instant`. */
export function wallClockAt(instant: Date, timeZone: string): WallClock {
  const parts = wallClockFormatter(timeZone).formatToParts(instant);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value ?? '0');
  return {
    year: partValue('year'),
    month: partValue('month') - 1,
    day: partValue('day'),
    // Some ICU builds still render midnight as `24` under a 24-hour cycle;
    // folding it back keeps the day the other fields name.
    hour: partValue('hour') % 24,
    minute: partValue('minute'),
    second: partValue('second'),
    // Zone offsets are whole seconds, so the sub-second part reads the same
    // on every clock.
    millisecond: instant.getUTCMilliseconds(),
  };
}

function wallClockAsUtcMilliseconds(wallClock: WallClock): number {
  return Date.UTC(
    wallClock.year,
    wallClock.month,
    wallClock.day,
    wallClock.hour,
    wallClock.minute,
    wallClock.second,
    wallClock.millisecond,
  );
}

/** How far `timeZone` is ahead of UTC at `instant`, in milliseconds. */
export function zoneOffsetMilliseconds(
  instant: Date,
  timeZone: string,
): number {
  const wholeSecond =
    Math.floor(instant.getTime() / MILLISECONDS_PER_SECOND) *
    MILLISECONDS_PER_SECOND;
  const wallClock = wallClockAt(new Date(wholeSecond), timeZone);
  return wallClockAsUtcMilliseconds(wallClock) - wholeSecond;
}

/**
 * The instant a clock in `timeZone` reads `wallClock`.
 *
 * Most wall times name exactly one instant. The two that do not resolve the
 * way ECMAScript resolves a local time on a `Date`, which is how the wizard
 * steps its own preview in the browser's zone, so both sides name the same
 * dates:
 *
 * - A wall time the clocks skip (spring forward, 01:30 in Lisbon on the last
 *   Sunday of March) uses the offset in force before the gap, so it lands one
 *   hour later on the clock: 02:30 summer time.
 * - A wall time the clocks repeat (fall back, 01:30 in Lisbon on the last
 *   Sunday of October) takes the earlier of its two instants, the first time
 *   the clock reads it.
 *
 * The offset in force can only be one of the two values either side of the
 * nearest transition, so both are sampled a day out from the naive reading
 * and each candidate is kept when a clock at that instant really reads the
 * wall time asked for.
 */
export function instantForWallClock(
  wallClock: WallClock,
  timeZone: string,
): Date {
  const wallClockMilliseconds = wallClockAsUtcMilliseconds(wallClock);
  const offsetBefore = zoneOffsetMilliseconds(
    new Date(wallClockMilliseconds - MILLISECONDS_PER_DAY),
    timeZone,
  );
  const offsetAfter = zoneOffsetMilliseconds(
    new Date(wallClockMilliseconds + MILLISECONDS_PER_DAY),
    timeZone,
  );
  const readsWallClock = (candidateMilliseconds: number): boolean =>
    candidateMilliseconds +
      zoneOffsetMilliseconds(new Date(candidateMilliseconds), timeZone) ===
    wallClockMilliseconds;

  const candidates = [
    wallClockMilliseconds - offsetBefore,
    wallClockMilliseconds - offsetAfter,
  ].filter(readsWallClock);
  if (candidates.length === 0) {
    // Skipped by the clocks: keep the offset from before the gap.
    return new Date(wallClockMilliseconds - offsetBefore);
  }
  // One candidate, or the same one twice, or a repeated hour's two instants,
  // of which the earlier wins.
  return new Date(Math.min(...candidates));
}

/**
 * The start of the occurrence `index` cadence steps after `base` (index 0 is
 * `base` itself), stepped on `timeZone`'s wall clock.
 *
 * Weekly and biweekly add 7 or 14 calendar days; monthly adds calendar months.
 * `Date.UTC` normalises an overflowing day the way `setMonth` always did, so a
 * series starting on the 31st rolls into the following month on a shorter one:
 * an accepted edge case for this deliberately minimal recurrence model (no
 * RFC5545 "same weekday" or "last day of the month").
 */
export function occurrenceStartAt(
  base: Date,
  cadence: RecurrenceCadence,
  index: number,
  timeZone: string,
): Date {
  if (index === 0) return new Date(base.getTime());
  const baseWallClock = wallClockAt(base, timeZone);
  const steppedWallClock: WallClock =
    cadence === 'monthly'
      ? { ...baseWallClock, month: baseWallClock.month + index }
      : {
          ...baseWallClock,
          day: baseWallClock.day + (cadence === 'weekly' ? 7 : 14) * index,
        };
  // `Date.UTC` folds the overflowing month or day into a real calendar date
  // before the zone is asked about it.
  const normalised = new Date(wallClockAsUtcMilliseconds(steppedWallClock));
  return instantForWallClock(
    {
      year: normalised.getUTCFullYear(),
      month: normalised.getUTCMonth(),
      day: normalised.getUTCDate(),
      hour: normalised.getUTCHours(),
      minute: normalised.getUTCMinutes(),
      second: normalised.getUTCSeconds(),
      millisecond: normalised.getUTCMilliseconds(),
    },
    timeZone,
  );
}
