import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

/**
 * PRD-265. Enforces that one governance-overview entry is EITHER seeded OR
 * authored, never both and never neither.
 *
 * A seeded entry carries `key`, a content key whose EN and PT already exist in
 * the frontend catalogs. An authored entry carries its own EN/PT prose in the
 * fields this decorator is told to look at (`lead`+`body` for a decision,
 * `title`+`text` for a principle, `role` for a council seat), because staff
 * wrote it after the bundle shipped and no key exists to translate.
 *
 * The exclusive-or is what keeps the reader honest: with both present the
 * renderer would have to pick one and silently discard the other, and with
 * neither the entry would render as a blank row on a public accountability
 * page. `@ValidateIf` alone cannot express it (it can require the authored
 * fields when `key` is absent, but not forbid them when it is present), so the
 * rule lives here, once, and all three entry DTOs apply it to their `key`.
 *
 * Applied to `key` rather than to the class so the message points at the field
 * an editor would actually change.
 */
export function IsSeededOrAuthored(
  authoredFieldNames: readonly string[],
  validationOptions?: ValidationOptions,
) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isSeededOrAuthored',
      target: object.constructor,
      propertyName,
      constraints: [authoredFieldNames],
      options: validationOptions,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          const [fieldNames] = args.constraints as [readonly string[]];
          const entry = args.object as Record<string, unknown>;
          const hasKey = entry.key !== undefined && entry.key !== null;
          const hasAuthoredText = fieldNames.some(
            (fieldName) =>
              entry[fieldName] !== undefined && entry[fieldName] !== null,
          );
          return hasKey !== hasAuthoredText;
        },
        defaultMessage(args: ValidationArguments): string {
          const [fieldNames] = args.constraints as [readonly string[]];
          return `an entry carries either "key" or ${fieldNames
            .map((fieldName) => `"${fieldName}"`)
            .join(' + ')}, never both and never neither`;
        },
      },
    });
  };
}
