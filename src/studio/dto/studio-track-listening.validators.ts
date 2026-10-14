import {
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import {
  isAscendingFromZero,
  isNonDecreasing,
  roundToTenth,
} from '../studio-track-listening';

/** `@Transform` for a loudness or peak value: one decimal, the precision
 *  `numeric(4,1)` keeps. Anything other than a finite number passes through
 *  for the validators to refuse. */
export const roundMeasurementValue = ({
  value,
}: {
  value: unknown;
}): unknown =>
  typeof value === 'number' && Number.isFinite(value)
    ? roundToTenth(value)
    : value;

/** The numbers under `key` in a list of objects, or null when the value is
 *  not such a list (the nested rules then report the shape). */
function numbersUnder(items: unknown, key: string): number[] | null {
  if (!Array.isArray(items)) {
    return null;
  }
  const numbers: number[] = [];
  for (const item of items as unknown[]) {
    if (typeof item !== 'object' || item === null) {
      return null;
    }
    const value = (item as Record<string, unknown>)[key];
    if (typeof value !== 'number') {
      return null;
    }
    numbers.push(value);
  }
  return numbers;
}

/**
 * The property travels with `partnerProperty`: both are sent, and both are
 * numbers or both are null. Pair it with `@ValidateIf(isPresentValue)` so it
 * runs for `null` and stays quiet when the property is omitted; the partner's
 * own copy of this rule then reports the missing half.
 */
export function IsPairedWith(
  partnerProperty: string,
  options?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isPairedWith',
      target: object.constructor,
      propertyName,
      constraints: [partnerProperty],
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const partnerValue = (args.object as Record<string, unknown>)[
            partnerProperty
          ];
          return (
            partnerValue !== undefined &&
            (value === null) === (partnerValue === null)
          );
        },
        defaultMessage(): string {
          return `${propertyName} and ${partnerProperty} are sent together: two numbers, or two nulls to clear them.`;
        },
      },
    });
  };
}

/** A finite number from `minimum` to `maximum`, or null to clear. */
export function IsMeasurementOrNull(
  minimum: number,
  maximum: number,
  options?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isMeasurementOrNull',
      target: object.constructor,
      propertyName,
      constraints: [minimum, maximum],
      options,
      validator: {
        validate(value: unknown): boolean {
          return (
            value === null ||
            (typeof value === 'number' &&
              Number.isFinite(value) &&
              value >= minimum &&
              value <= maximum)
          );
        },
        defaultMessage(): string {
          return `${propertyName} must be a number from ${minimum} to ${maximum}, or null.`;
        },
      },
    });
  };
}

/** Each timed lyric line starts at or after the line before it. */
export function HasNonDecreasingTimes(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'hasNonDecreasingTimes',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          const times = numbersUnder(value, 'ms');
          return times !== null && isNonDecreasing(times);
        },
        defaultMessage(): string {
          return 'Each timed lyric line starts at or after the line before it.';
        },
      },
    });
  };
}

/** The first chapter starts at 0 and each later one after the one before. */
export function HasChapterTimeline(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'hasChapterTimeline',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          const starts = numbersUnder(value, 'startSeconds');
          return starts !== null && isAscendingFromZero(starts);
        },
        defaultMessage(): string {
          return 'The first chapter starts at 0 and each later chapter starts after the one before it.';
        },
      },
    });
  };
}
