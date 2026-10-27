import { BadRequestException } from '@nestjs/common';
import type { AdminFeatureUsageDTO } from './feature-usage-response';

/**
 * Range resolution for the admin feature-usage endpoints. Pure functions, no
 * Nest DI, so every rule here is directly unit-testable with a fixed `now`.
 *
 * A caller names a range one of two ways: a preset length (`rangeDays`, the
 * window ending at the start of today) or a custom pair of inclusive days
 * (`from` and `to`). Both resolve to the same `UsageRange`, whose `rangeEnd`
 * is EXCLUSIVE (UTC midnight after the last included day), so every
 * predicate downstream keeps reading `>= rangeStart AND < rangeEnd`. The
 * inclusive day strings the wire carries come from `describeUsageRange`.
 */

export const FEATURE_USAGE_MIN_RANGE_DAYS = 1;

/** Largest window either form accepts. Bounds the historical scan
 *  `AdminFeatureUsageService.getUsage` runs across every depth-tracked
 *  entity table, and keeps the UTC day arithmetic inside `Date`'s safe
 *  range. */
export const FEATURE_USAGE_MAX_RANGE_DAYS = 365;

/** Preset length used when the request names no range at all. */
export const FEATURE_USAGE_DEFAULT_RANGE_DAYS = 30;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

const DATE_ONLY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const INTEGER_PATTERN = /^-?\d+$/;

/** Longest slice of a rejected query value echoed back in an error message. */
const MAX_ECHOED_VALUE_LENGTH = 24;

/** Every `code` a range rejection carries, one per cause. */
export const FEATURE_USAGE_RANGE_ERROR_CODES = {
  conflictingParams: 'feature_usage_range_conflicting_params',
  incomplete: 'feature_usage_range_incomplete',
  invalidDate: 'feature_usage_range_invalid_date',
  invalidDays: 'feature_usage_range_invalid_days',
  reversed: 'feature_usage_range_reversed',
  tooLong: 'feature_usage_range_too_long',
  beforeRetention: 'feature_usage_range_before_retention',
  includesToday: 'feature_usage_range_includes_today',
} as const;

export type FeatureUsageRangeErrorCode =
  (typeof FEATURE_USAGE_RANGE_ERROR_CODES)[keyof typeof FEATURE_USAGE_RANGE_ERROR_CODES];

export interface UsageRange {
  rangeDays: number;
  /** Inclusive, UTC midnight. */
  rangeStart: Date;
  /** EXCLUSIVE, UTC midnight after the last included day. */
  rangeEnd: Date;
  /** Inclusive; the previous window is `[previousRangeStart, rangeStart)`. */
  previousRangeStart: Date;
  /** Earliest day `feature_usage_daily` still keeps, UTC midnight. */
  retentionStart: Date;
}

/** Raw query values exactly as the controller receives them. */
export interface UsageRangeQuery {
  rangeDays?: string;
  from?: string;
  to?: string;
}

/** `feature_usage_daily.day` is a `date` column; compares correctly against a
 *  bare `YYYY-MM-DD` string taken from a UTC instant. */
export function toDateOnlyString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Midnight UTC on `date`'s own calendar day. Anchors every window to a
 *  whole-day boundary, so the exact instant a request arrives never moves a
 *  range. */
export function startOfUtcDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()),
  );
}

function addUtcDays(date: Date, amount: number): Date {
  return new Date(date.getTime() + amount * MILLISECONDS_PER_DAY);
}

/** `count` consecutive UTC days starting at `start`, oldest first, as
 *  `YYYY-MM-DD` strings. Used to zero-fill every daily series. */
export function listUtcDays(start: Date, count: number): string[] {
  const days: string[] = [];
  for (let offset = 0; offset < count; offset += 1) {
    days.push(toDateOnlyString(addUtcDays(start, offset)));
  }
  return days;
}

function rangeError(
  code: FeatureUsageRangeErrorCode,
  message: string,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    code,
    message,
  });
}

function echoValue(value: unknown): string {
  return JSON.stringify(String(value).slice(0, MAX_ECHOED_VALUE_LENGTH));
}

function isProvided(value: unknown): boolean {
  return value !== undefined;
}

/** Parses an inclusive `YYYY-MM-DD` query day into UTC midnight, rejecting
 *  anything that is not a real calendar day (`2026-02-30`, `26-10-01`). */
function parseQueryDay(rawDay: unknown, parameterName: 'from' | 'to'): Date {
  const match =
    typeof rawDay === 'string' ? DATE_ONLY_PATTERN.exec(rawDay) : null;
  if (match) {
    const year = Number(match[1]);
    const monthIndex = Number(match[2]) - 1;
    const dayOfMonth = Number(match[3]);
    const parsedDay = new Date(Date.UTC(year, monthIndex, dayOfMonth));
    const isRealCalendarDay =
      parsedDay.getUTCFullYear() === year &&
      parsedDay.getUTCMonth() === monthIndex &&
      parsedDay.getUTCDate() === dayOfMonth;
    if (isRealCalendarDay) return parsedDay;
  }
  throw rangeError(
    FEATURE_USAGE_RANGE_ERROR_CODES.invalidDate,
    `${parameterName} must be a real calendar day written as YYYY-MM-DD; received ${echoValue(rawDay)}.`,
  );
}

/** Parses `rangeDays` as a whole number and clamps it into
 *  `[FEATURE_USAGE_MIN_RANGE_DAYS, FEATURE_USAGE_MAX_RANGE_DAYS]`. The clamp
 *  is the long-standing behaviour of this endpoint, and the DTO echoes the
 *  clamped value, so a caller asking for 1000 days reads back 365. */
function parseRangeDays(rawRangeDays: unknown): number {
  if (typeof rawRangeDays !== 'string' || !INTEGER_PATTERN.test(rawRangeDays)) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.invalidDays,
      `rangeDays must be a whole number of days from ${FEATURE_USAGE_MIN_RANGE_DAYS} to ${FEATURE_USAGE_MAX_RANGE_DAYS}; received ${echoValue(rawRangeDays)}.`,
    );
  }
  return Math.min(
    Math.max(Number(rawRangeDays), FEATURE_USAGE_MIN_RANGE_DAYS),
    FEATURE_USAGE_MAX_RANGE_DAYS,
  );
}

function presetRange(
  rangeDays: number,
  startOfToday: Date,
  retentionStart: Date,
): UsageRange {
  const rangeStart = addUtcDays(startOfToday, -rangeDays);
  return {
    rangeDays,
    rangeStart,
    rangeEnd: startOfToday,
    previousRangeStart: addUtcDays(rangeStart, -rangeDays),
    retentionStart,
  };
}

function customRange(
  rawFrom: unknown,
  rawTo: unknown,
  startOfToday: Date,
  retentionStart: Date,
  retentionDays: number,
): UsageRange {
  const fromDay = parseQueryDay(rawFrom, 'from');
  const toDay = parseQueryDay(rawTo, 'to');
  const fromText = toDateOnlyString(fromDay);
  const toText = toDateOnlyString(toDay);

  if (fromDay.getTime() > toDay.getTime()) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.reversed,
      `from (${fromText}) falls after to (${toText}); the start day has to come first.`,
    );
  }

  const rangeDays =
    Math.round((toDay.getTime() - fromDay.getTime()) / MILLISECONDS_PER_DAY) +
    1;
  if (rangeDays > FEATURE_USAGE_MAX_RANGE_DAYS) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.tooLong,
      `A custom range covers at most ${FEATURE_USAGE_MAX_RANGE_DAYS} days; ${fromText} to ${toText} covers ${rangeDays} days.`,
    );
  }

  if (fromDay.getTime() < retentionStart.getTime()) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.beforeRetention,
      `Reach is kept for ${retentionDays} days, so from has to be ${toDateOnlyString(retentionStart)} or later; received ${fromText}.`,
    );
  }

  if (toDay.getTime() >= startOfToday.getTime()) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.includesToday,
      `Today (${toDateOnlyString(startOfToday)}, UTC) is still being counted, so to has to be ${toDateOnlyString(addUtcDays(startOfToday, -1))} or earlier; received ${toText}.`,
    );
  }

  return {
    rangeDays,
    rangeStart: fromDay,
    rangeEnd: addUtcDays(toDay, 1),
    previousRangeStart: addUtcDays(fromDay, -rangeDays),
    retentionStart,
  };
}

/**
 * Resolves the query into one `UsageRange`, or throws a `BadRequestException`
 * whose body carries a specific `code` from `FEATURE_USAGE_RANGE_ERROR_CODES`
 * and a message naming the limit that was crossed.
 *
 * Preset: `rangeEnd` is the start of today UTC and `rangeStart` is
 * `rangeDays` whole days before it. Custom: `rangeStart` is `from` and
 * `rangeEnd` is the day after `to`. Either way the previous window has the
 * same length and ends where this one starts. `retentionStart` is the start
 * of today minus `retentionDays`, the same cutoff day
 * `FeatureUsageRetentionService` deletes before.
 */
export function resolveUsageRange(
  query: UsageRangeQuery,
  now: Date,
  retentionDays: number,
): UsageRange {
  const startOfToday = startOfUtcDay(now);
  const retentionStart = addUtcDays(startOfToday, -retentionDays);
  const hasRangeDays = isProvided(query.rangeDays);
  const hasFrom = isProvided(query.from);
  const hasTo = isProvided(query.to);

  if (hasRangeDays && (hasFrom || hasTo)) {
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.conflictingParams,
      'Send rangeDays on its own for a preset range, or from and to together for a custom range; this request sent rangeDays alongside from or to.',
    );
  }

  if (hasFrom !== hasTo) {
    const missingParameter = hasFrom ? 'to' : 'from';
    throw rangeError(
      FEATURE_USAGE_RANGE_ERROR_CODES.incomplete,
      `A custom range needs both from and to as YYYY-MM-DD; ${missingParameter} is missing.`,
    );
  }

  if (hasFrom && hasTo) {
    return customRange(
      query.from,
      query.to,
      startOfToday,
      retentionStart,
      retentionDays,
    );
  }

  const rangeDays = hasRangeDays
    ? parseRangeDays(query.rangeDays)
    : FEATURE_USAGE_DEFAULT_RANGE_DAYS;
  return presetRange(rangeDays, startOfToday, retentionStart);
}

/**
 * The wire form of a `UsageRange`: every date an INCLUSIVE `YYYY-MM-DD` day.
 * `rangeEnd` is the last included day (the internal exclusive end minus one
 * day), and `previousRangeEnd` is the day before `rangeStart`.
 */
export function describeUsageRange(
  range: UsageRange,
): Pick<
  AdminFeatureUsageDTO,
  | 'rangeStart'
  | 'rangeEnd'
  | 'previousRangeStart'
  | 'previousRangeEnd'
  | 'retentionStart'
  | 'isPreviousRangePartial'
> {
  return {
    rangeStart: toDateOnlyString(range.rangeStart),
    rangeEnd: toDateOnlyString(addUtcDays(range.rangeEnd, -1)),
    previousRangeStart: toDateOnlyString(range.previousRangeStart),
    previousRangeEnd: toDateOnlyString(addUtcDays(range.rangeStart, -1)),
    retentionStart: toDateOnlyString(range.retentionStart),
    isPreviousRangePartial:
      range.previousRangeStart.getTime() < range.retentionStart.getTime(),
  };
}
