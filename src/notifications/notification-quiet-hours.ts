/**
 * Pure clock arithmetic for a member's quiet-hours window. Kept free of Nest,
 * TypeORM and the request context so the wrapping-midnight cases can be reasoned
 * about (and unit-tested) as plain functions.
 */

/** Minutes in a day, the exclusive upper bound of every minute-of-day value. */
export const MINUTES_PER_DAY = 24 * 60;

/**
 * `true` when `timeZone` is an IANA zone this runtime knows. Node throws a
 * `RangeError` for an unknown zone, so the cheapest reliable probe is to build a
 * formatter with it and catch. Used by the DTO validator so a typo is a 400 at
 * the boundary rather than a throw inside the send path months later.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The minute-of-day (0..1439) that `instant` falls on in `timeZone`.
 *
 * Formats to a 24-hour `HH:mm` in the target zone and reads the two numbers back
 * out. This is the only DST-correct way to do it without a date library: the
 * zone database inside `Intl` already knows that on the changeover night the
 * local clock is not `UTC + fixed offset`. An unknown zone degrades to UTC
 * rather than throwing, because a push is best-effort and a bad stored zone must
 * never take the send path down.
 */
export function localMinuteOfDay(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: isKnownTimeZone(timeZone) ? timeZone : 'UTC',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(instant);
  const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? '0');
  const minute = Number(
    parts.find((part) => part.type === 'minute')?.value ?? '0',
  );
  // `hour12: false` renders midnight as `24` in some ICU versions; fold it back.
  return ((hour % 24) * 60 + minute) % MINUTES_PER_DAY;
}

/**
 * Whether `minuteOfDay` sits inside the half-open window `[start, end)`.
 *
 * Half-open on purpose: a member whose window ends at 08:00 expects the 08:00
 * push to arrive. A window that wraps midnight (`start > end`, e.g. 22:00 to
 * 08:00) is the union of the two straddling ranges. `start === end` is an empty
 * window rather than a whole day, so a mis-set pair never silences a member
 * permanently.
 */
export function isMinuteWithinWindow(
  minuteOfDay: number,
  startMinute: number,
  endMinute: number,
): boolean {
  if (startMinute === endMinute) return false;
  return startMinute < endMinute
    ? minuteOfDay >= startMinute && minuteOfDay < endMinute
    : minuteOfDay >= startMinute || minuteOfDay < endMinute;
}

/** One member's stored window, in the shape the check below needs. */
export interface QuietHoursWindow {
  isQuietHoursEnabled: boolean;
  quietHoursStartMinute: number;
  quietHoursEndMinute: number;
  timeZone: string;
}

/** `true` when `instant` falls inside this member's enabled quiet-hours window. */
export function isWithinQuietHours(
  window: QuietHoursWindow,
  instant: Date,
): boolean {
  if (!window.isQuietHoursEnabled) return false;
  return isMinuteWithinWindow(
    localMinuteOfDay(instant, window.timeZone),
    window.quietHoursStartMinute,
    window.quietHoursEndMinute,
  );
}
