/**
 * Funding & Grants (P3): which deadline reminder, if any, is due today.
 *
 * Counted in LISBON CALENDAR DAYS, the days members live in. A call that
 * closes at 23:59 UTC on 12 October closes at 00:59 on the 13th in Lisbon
 * during summer time, so its "closes tomorrow" goes out on the 12th; counting
 * UTC days would send it a day late. The copy says "closes in 7 days" and
 * "closes tomorrow", so a reminder fires only on the exact day that makes the
 * sentence true, and a missed cron day stays missed.
 */

export const FUNDING_REMINDER_TIME_ZONE = 'Europe/Lisbon';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How far ahead the sweep reads: one day past the 7-day stage. */
export const FUNDING_REMINDER_LOOKAHEAD_MS = 8 * DAY_MS;

export type FundingReminderStage = '7d' | '1d';

const LISBON_DATE_FORMAT = new Intl.DateTimeFormat('en-GB', {
  timeZone: FUNDING_REMINDER_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

function lisbonDayNumber(instant: Date): number {
  const parts = LISBON_DATE_FORMAT.formatToParts(instant);
  const partValue = (type: Intl.DateTimeFormatPartTypes): number =>
    Number(parts.find((part) => part.type === type)?.value);
  return (
    Date.UTC(partValue('year'), partValue('month') - 1, partValue('day')) /
    DAY_MS
  );
}

/** Whole Lisbon calendar days from `from`'s date to `to`'s date. */
export function lisbonCalendarDaysBetween(from: Date, to: Date): number {
  return lisbonDayNumber(to) - lisbonDayNumber(from);
}

export function reminderStageFor(
  deadline: Date,
  now: Date,
): FundingReminderStage | null {
  if (deadline.getTime() <= now.getTime()) return null;
  const daysAhead = lisbonCalendarDaysBetween(now, deadline);
  if (daysAhead === 7) return '7d';
  if (daysAhead === 1) return '1d';
  return null;
}
