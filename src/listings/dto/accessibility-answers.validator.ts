import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import {
  isListingAccessibilityAnswer,
  isListingAccessibilityQuestionSlug,
  LISTING_ACCESSIBILITY_QUESTION_SLUGS,
} from '../listing-accessibility';

/**
 * Property decorator for the `accessibility.answers` map: every KEY must be
 * one of the canonical question slugs and every VALUE one of the three
 * answers.
 *
 * A fixed-key DTO class (the shape `ListingHoursDto` uses for weekdays) would
 * have restated all six slugs a second time, and the whole point of
 * `listing-accessibility.ts` is that the vocabulary is written down once. This
 * validates the same map against that one list instead, so adding a question
 * there is the only edit a new question needs.
 *
 * An unknown slug is REJECTED rather than quietly dropped. A client sending
 * `hearing-loop` has either a typo or a question this API does not know about,
 * and silently discarding it would leave the submitter believing they answered
 * something they did not.
 */
export function IsAccessibilityAnswerMap(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isAccessibilityAnswerMap',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(value: unknown): boolean {
          if (value === undefined || value === null) return true;
          if (typeof value !== 'object' || Array.isArray(value)) return false;
          for (const [slug, answer] of Object.entries(
            value as Record<string, unknown>,
          )) {
            if (!isListingAccessibilityQuestionSlug(slug)) return false;
            if (!isListingAccessibilityAnswer(answer)) return false;
          }
          return true;
        },
        defaultMessage(args: ValidationArguments): string {
          return (
            `${args.property} must map known accessibility questions ` +
            `(${LISTING_ACCESSIBILITY_QUESTION_SLUGS.join(', ')}) ` +
            'to one of: yes, no, unknown.'
          );
        },
      },
    });
  };
}
