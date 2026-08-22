import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * `rateMax` must not sit below `rateMin`. Nothing stopped a poster from
 * submitting "€60/hour to €40/hour", which then renders as an inverted range on
 * the job card and sorts nonsensically on the board.
 *
 * Declared on `rateMax` (rather than as a class-level rule) so the error points
 * at the field the poster should fix, and so it behaves on `UpdateJobDto`, a
 * `PartialType` where either half may be absent: with only one of the two in
 * the payload there is no pair to compare and the rule stands down.
 */
export function IsNotBelowRateMin(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isNotBelowRateMin',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown, args: ValidationArguments) {
          const rateMin = (args.object as { rateMin?: unknown }).rateMin;
          if (typeof value !== 'number' || typeof rateMin !== 'number') {
            return true;
          }
          return value >= rateMin;
        },
        defaultMessage() {
          return 'rateMax must be greater than or equal to rateMin';
        },
      },
    });
  };
}
