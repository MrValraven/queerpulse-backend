import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

interface ContactFieldsShape {
  phone?: string | null;
  email?: string | null;
  website?: string | null;
}

/** True when at least one of phone/email/website is a non-blank string. */
function hasContactField(candidate: ContactFieldsShape): boolean {
  return Boolean(
    candidate.phone?.trim() ||
    candidate.email?.trim() ||
    candidate.website?.trim(),
  );
}

/**
 * Class-level rule for `CreateResourceListingDto`: a `ResourceListing` is a
 * real-world organisation someone needs to be able to reach, so the row must
 * carry at least one of `phone`/`email`/`website` (the design doc's
 * "Contact: ... all nullable, at least one required — app-level
 * validation"). Deliberately attached to `title` — a field that is NEVER
 * `@IsOptional()` on `CreateResourceListingDto` — rather than to one of the
 * three contact fields themselves: class-validator's `@IsOptional()` skips
 * EVERY decorator on the property it's attached to (not just its own check)
 * whenever that property's value is `undefined`, so attaching this rule to
 * (say) `phone` would silently stop enforcing it the moment a request omits
 * `phone` and only sends `email` — exactly the common case. Attaching it to
 * the always-required `title` instead means it runs on every create,
 * unconditionally, reading `phone`/`email`/`website` off the whole DTO via
 * `args.object`. Mirrors `IsValidDayHours`'s class-object read.
 *
 * `UpdateResourceListingDto` inherits this via `PartialType`, where `title`
 * becomes optional too — so on a PATCH this only fires when the request
 * happens to include `title`, which isn't a reliable guarantee. That's
 * intentional: a PATCH can legitimately touch only one field, so the
 * authoritative check for updates is `hasAtLeastOneContactField` below, run
 * against the fully merged row in `AdminResourceListingsService.update`.
 */
export function HasAtLeastOneContactField(options?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'hasAtLeastOneContactField',
      target: object.constructor,
      propertyName,
      options,
      validator: {
        validate(_value: unknown, args: ValidationArguments): boolean {
          return hasContactField(args.object);
        },
        defaultMessage(): string {
          return 'A resource listing needs at least one of phone, email or website.';
        },
      },
    });
  };
}

/**
 * The same rule as a plain function, for use outside class-validator —
 * `AdminResourceListingsService.update` calls this against the fully merged
 * entity (existing values + the PATCH's changes) after applying the update,
 * since the DTO-level decorator above can't see that merged state.
 */
export function hasAtLeastOneContactField(
  candidate: ContactFieldsShape,
): boolean {
  return hasContactField(candidate);
}
