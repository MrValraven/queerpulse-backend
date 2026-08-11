import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { isSafeUrlValue } from '../../common/validators/is-safe-url.decorator';
import type { ItemStructured } from '../entities/subprofile-item.entity';
import { KNOWN_PLATFORM_KEYS, MAX_SOCIAL_LINKS } from '../subprofile-validation';

// `structured` is otherwise a bare `@IsObject()` blob (courses/snippet are a
// documented Phase-0 no-validate limitation), but its nested `links[]` array is
// rendered as `<a href>` on the persona page exactly like the persona-level
// social links — so an unchecked `urlOrHandle` here is the SAME stored-XSS hole
// `@IsSafeUrl` closes on the top-level social-link DTO. This validator walks
// `structured.links[]` and rejects the whole field (field-level 400) unless
// every entry carries a known `platform` and a safe `urlOrHandle` (https/mailto/
// bare @handle — never `javascript:`/`data:`/`vbscript:`), reusing the exact
// `isSafeUrlValue` predicate behind `@IsSafeUrl({ allowHandle: true })`.
//
// It ONLY inspects `links` — every other key in `structured` is left to the
// `@IsObject()` shape check + the service's 16 KB serialized-size cap, so this
// adds no new constraint on `courses`/`snippet`.
function isKnownPlatform(platform: unknown): boolean {
  return (
    typeof platform === 'string' &&
    (KNOWN_PLATFORM_KEYS as readonly string[]).includes(platform)
  );
}

function structuredLinksAreSafe(value: unknown): boolean {
  // A missing/undefined `structured` (or one without `links`) is fine — the
  // field is optional and only the `links` array is constrained here.
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== 'object') {
    // Non-object `structured` is caught by the sibling `@IsObject()`; don't
    // double-fault it here.
    return true;
  }
  const links = (value as ItemStructured).links;
  if (links === null || links === undefined) {
    return true;
  }
  if (!Array.isArray(links)) {
    return false;
  }
  if (links.length > MAX_SOCIAL_LINKS) {
    return false;
  }
  return links.every((link) => {
    if (link === null || typeof link !== 'object') {
      return false;
    }
    const { platform, urlOrHandle } = link as {
      platform?: unknown;
      urlOrHandle?: unknown;
    };
    return (
      isKnownPlatform(platform) &&
      typeof urlOrHandle === 'string' &&
      urlOrHandle.trim().length > 0 &&
      // Same allowlist as the persona-level social link: scheme must be
      // https/mailto, or a scheme-less bare handle.
      isSafeUrlValue(urlOrHandle, true)
    );
  });
}

/**
 * Validates that a subprofile item's `structured.links[]` (if present) carries
 * only known platforms and safe, non-executable `urlOrHandle` values. Attach
 * alongside the field's existing `@IsObject()`.
 */
export function IsSafeStructuredLinks(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeStructuredLinks',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return structuredLinksAreSafe(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property}.links must each carry a known platform and an https:// URL, a mailto: link, or a bare handle`;
        },
      },
    });
  };
}
