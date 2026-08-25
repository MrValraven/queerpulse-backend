import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Validation rules that span a whole `hoursExceptions` entry (or the whole
 * array), which class-validator's per-property decorators cannot express.
 *
 * The per-date opening rules themselves are NOT re-implemented here:
 * `ListingHoursExceptionDto` extends `ListingDayHoursDto`, so `open` and
 * `intervals` are checked by the very same `@IsValidDayHours()` rule the
 * weekday grid uses (`day-hours.validator.ts`). What is left over is a real
 * calendar date, and the array-level uniqueness of those dates.
 */

const YYYY_MM_DD = /^(\d{4})-(\d{2})-(\d{2})$/;

/**
 * True when `value` is a `YYYY-MM-DD` string naming a date that actually
 * exists. The format regex alone accepts `2026-02-31` and `2026-13-01`, so the
 * parts are round-tripped through `Date.UTC` and compared back: a rolled-over
 * date (31 February becoming 3 March) no longer matches what was written.
 */
function isCalendarDateString(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const match = YYYY_MM_DD.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const roundTripped = new Date(Date.UTC(year, month - 1, day));
  return (
    roundTripped.getUTCFullYear() === year &&
    roundTripped.getUTCMonth() === month - 1 &&
    roundTripped.getUTCDate() === day
  );
}

/**
 * Property decorator asserting a `YYYY-MM-DD` string names a real calendar
 * date. Pair it with the `@Matches` format check so a malformed string and an
 * impossible one both surface as field errors the frontend can route back to
 * the hours step.
 */
export function IsCalendarDate(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isCalendarDate',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          return isCalendarDateString(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must be a real calendar date in YYYY-MM-DD form.`;
        },
      },
    });
  };
}

/**
 * Property decorator for the `hoursExceptions` ARRAY: every entry must cover a
 * different calendar date.
 *
 * Two entries for one date have no defined winner, and the frontend's "open
 * now" arithmetic would silently pick whichever came first in the jsonb array,
 * so a venue could publish "closed" and "open 10:00-14:00" for the same
 * Christmas Eve and get either answer. Rejected at the write boundary instead.
 *
 * Entries whose `date` is missing or not a string are ignored here: they
 * already fail their own `@IsString()`/`@IsCalendarDate()` checks, and this
 * rule must not pile a confusing second error onto the same input.
 */
export function HasUniqueExceptionDates(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'hasUniqueExceptionDates',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (!Array.isArray(value)) return true;
          const seenDates = new Set<string>();
          for (const entry of value as { date?: unknown }[]) {
            const date = entry?.date;
            if (typeof date !== 'string') continue;
            if (seenDates.has(date)) return false;
            seenDates.add(date);
          }
          return true;
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must not contain two entries for the same date.`;
        },
      },
    });
  };
}
