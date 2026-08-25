import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  collectAcceptedSuggestionValueErrors,
  resolveAcceptedSuggestionTarget,
} from '../accepted-suggestion-value';

/**
 * Cross-field rule for `CreateEditSuggestionDto.proposedValue`: the typed
 * replacement value a member offers alongside their prose has to satisfy the
 * rules the real `Listing` column enforces, and which column that is depends on
 * the sibling `field` property. class-validator's per-property decorators can
 * only see one property at a time, so the check lives here as a decorator that
 * reads `args.object.field` and dispatches through the shared
 * `accepted-suggestion-value.ts` machinery.
 *
 * Reusing that machinery is the whole point. A second copy of "phone is at most
 * 60 chars, website must pass `@IsSafeExternalUrl()`" would drift from the
 * accept path the moment either side is hardened, and a member would then be
 * able to submit a proposal the accept path later refuses to write. Every
 * bound checked here is the same instance of the same decorator the accept
 * path runs.
 */

interface EditSuggestionFieldCarrier {
  field?: unknown;
}

/**
 * The one place the "no proposed value without a writable target" refusal is
 * worded, shared by `validate` and `defaultMessage` so the two can never
 * disagree about why a value was rejected.
 */
function explainInvalidProposedValue(
  field: unknown,
  value: unknown,
): string | null {
  if (typeof value !== 'string') {
    return 'proposedValue must be a string.';
  }
  if (typeof field !== 'string') {
    return 'proposedValue needs a valid "field" to be checked against.';
  }
  const target = resolveAcceptedSuggestionTarget(field);
  if (target === null) {
    return (
      `The "${field}" bucket has no listing column a replacement value could ` +
      'be written to, so it takes prose only. Describe the correction in ' +
      '"message", or pick the specific field you can supply a new value for.'
    );
  }
  const constraintFailures = collectAcceptedSuggestionValueErrors(
    target,
    value,
  );
  if (constraintFailures.length === 0) {
    return null;
  }
  return `proposedValue is not valid for "${field}": ${constraintFailures.join(
    '; ',
  )}`;
}

/**
 * Property decorator asserting `proposedValue` is something the accept path
 * could actually write, given the sibling `field`. Applied to
 * `CreateEditSuggestionDto` so the global `ValidationPipe` returns the failure
 * as a 400 at submit time, while the member still has the form open.
 */
export function IsValidProposedSuggestionValue(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isValidProposedSuggestionValue',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown, args: ValidationArguments): boolean {
          const carrier = args.object as EditSuggestionFieldCarrier;
          return explainInvalidProposedValue(carrier.field, value) === null;
        },
        defaultMessage(args: ValidationArguments): string {
          const carrier = args.object as EditSuggestionFieldCarrier;
          return (
            explainInvalidProposedValue(carrier.field, args.value) ??
            'proposedValue is not valid for this field.'
          );
        },
      },
    });
  };
}
