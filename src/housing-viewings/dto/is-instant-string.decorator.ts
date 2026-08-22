import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * A full ISO-8601 instant: date AND time AND an explicit UTC offset
 * (`2026-09-01T18:30:00.000Z` or `2026-09-01T19:30:00+01:00`).
 *
 * `@IsDateString()` accepts a date-only value like `"2026-09-01"`, which
 * `new Date(...)` reads as UTC midnight. A Lisbon lister then sees "01:00 on
 * 1 September" in summer and "00:00" in winter for the same stored slot, so a
 * viewing time silently shifts across a DST boundary. Requiring the offset
 * makes the wall-clock instant the client meant unambiguous before it is
 * persisted, which also keeps `accept()`'s exact-millisecond slot match honest.
 */
const INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

export function IsInstantString(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isInstantString',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (typeof value !== 'string' || !INSTANT_PATTERN.test(value)) {
            return false;
          }
          // The pattern accepts shapes like `2026-02-31T10:00:00Z`; only
          // parsing rejects an impossible calendar date.
          return Number.isFinite(Date.parse(value));
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a full ISO-8601 date-time with a UTC offset, for example 2026-09-01T18:30:00.000Z`;
        },
      },
    });
  };
}
