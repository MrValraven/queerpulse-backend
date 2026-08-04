import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * Cross-field validity rules for one weekday's opening hours (the split-interval
 * shape `{ open, intervals }` introduced by item #6). class-validator's
 * per-property decorators can check each interval's `from`/`to` format in
 * isolation, but the *relationships* — an open day needs at least one interval,
 * a zero-length interval (`to === from`) is invalid, and two intervals in the
 * same day must not overlap — span the whole object, so they live here as a
 * single class-level rule applied to the `intervals` property.
 *
 * `to < from` is deliberately VALID: it denotes an OVERNIGHT interval that
 * closes the next day (e.g. `22:00`→`02:00`). Overlap detection therefore
 * expands every interval into one or two concrete `[start, end)` minute
 * segments on a 0..1440 timeline (an overnight interval becomes two segments,
 * wrapping midnight) before checking any pair for intersection.
 */

const HH_MM = /^([01]\d|2[0-3]):[0-5]\d$/;

function toMinutes(value: string): number {
  const [hours, minutes] = value.split(':');
  return Number(hours) * 60 + Number(minutes);
}

/** Concrete half-open `[start, end)` minute segments for one interval, splitting
 * an overnight interval (`to <= from`) into two so a plain numeric-overlap test
 * works on the wrapped timeline. */
function segmentsFor(from: string, to: string): [number, number][] {
  const start = toMinutes(from);
  const end = toMinutes(to);
  if (end > start) return [[start, end]];
  // Overnight: [start, 1440) ∪ [0, end). `end === start` is rejected upstream
  // (zero-length), so this branch only ever runs for a genuine wrap.
  return [
    [start, 24 * 60],
    [0, end],
  ];
}

function segmentsOverlap(
  first: [number, number],
  second: [number, number],
): boolean {
  return first[0] < second[1] && second[0] < first[1];
}

interface DayHoursShape {
  open?: boolean;
  intervals?: { from?: string; to?: string }[];
}

/** True when the day's `open`/`intervals` combination satisfies every rule. */
function isValidDayHours(day: DayHoursShape): boolean {
  const intervals = day.intervals ?? [];

  // A closed day carries no intervals — an explicit empty list is fine; a
  // stray populated list on a closed day is a contradiction and rejected.
  if (!day.open) {
    return intervals.length === 0;
  }

  // An open day needs at least one interval, capped at two (lunch + dinner).
  if (intervals.length < 1 || intervals.length > 2) {
    return false;
  }

  const expandedSegments: [number, number][][] = [];
  for (const interval of intervals) {
    const from = interval.from ?? '';
    const to = interval.to ?? '';
    // Both times must be present and well-formed `HH:MM`.
    if (!HH_MM.test(from) || !HH_MM.test(to)) {
      return false;
    }
    // Zero-length interval is meaningless.
    if (to === from) {
      return false;
    }
    expandedSegments.push(segmentsFor(from, to));
  }

  // With at most two intervals there is a single pair to compare; expand both
  // into their (possibly wrapped) segments and reject any intersection.
  if (expandedSegments.length === 2) {
    for (const firstSegment of expandedSegments[0]!) {
      for (const secondSegment of expandedSegments[1]!) {
        if (segmentsOverlap(firstSegment, secondSegment)) {
          return false;
        }
      }
    }
  }

  return true;
}

/**
 * Property decorator asserting the object it is attached to is a valid
 * `{ open, intervals }` weekday. Applied to `ListingDayHoursDto` (via a marker
 * property) so the global `ValidationPipe` surfaces a typed field error the
 * frontend's 422→step mapper (item #4) can route back to the hours step.
 */
export function IsValidDayHours(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidDayHours',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return isValidDayHours(args.object);
        },
        defaultMessage(): string {
          return (
            'An open day needs 1-2 non-overlapping intervals, each with a ' +
            'valid HH:MM start and end (start must differ from end); a closed ' +
            'day must have no intervals.'
          );
        },
      },
    });
  };
}
