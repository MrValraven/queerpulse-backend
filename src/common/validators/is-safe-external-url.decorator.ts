import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Schemes a browser will execute or treat as an inline document when they reach
// an `<a href>` / `window.open`. `data:` and `file:` aren't script per se, but
// they're never a legitimate "my website" value and both are XSS/exfil vectors,
// so they're refused alongside the two scripting schemes.
const DANGEROUS_URL_SCHEMES = ['javascript:', 'data:', 'vbscript:', 'file:'];

// Every ASCII control character and space (U+0000–U+0020). A browser ignores
// these when resolving a URL's scheme, so `  JavaScript:` and `java\tscript:`
// both execute — we strip them out before testing rather than let a naive
// `startsWith` be fooled by them.
// Matching the ASCII control-char range is the deliberate purpose of this
// scheme-smuggling defence, so the control-char rule is suppressed below.
// eslint-disable-next-line no-control-regex
const STRIPPED_CONTROL_CHARACTERS = /[\u0000-\u0020]/g;

/**
 * A member-editable "external URL" field — a business/partner `website`, a job
 * `link`. These were previously `@IsString()` with only a length cap, so a
 * client could persist `javascript:steal()` or a `data:` document that another
 * member's browser would run the moment the value was rendered as a link.
 *
 * This is deliberately a *scheme blocklist*, not `@IsUrl({ require_protocol })`:
 * the goal is to close the dangerous-scheme hole WITHOUT narrowing which
 * legitimate values are accepted. Those fields legitimately hold an empty
 * string (`listings.service` stores `website ?? ''`, and forms send `''` for an
 * unset URL) and protocol-less input (`example.com`, which the frontend renders
 * behind an `https://` prefix) — a strict `@IsUrl` rejects both. So we allow
 * everything except the handful of schemes that are actually exploitable.
 */
export function IsSafeExternalUrl(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeExternalUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          if (value === null) {
            return true;
          }
          if (typeof value !== 'string') {
            return false;
          }
          // An empty string means "no URL", exactly like `null` above — this is
          // what the old `@IsString()` validation allowed and what every form
          // sends for an unset field (`@IsOptional()` only skips
          // `undefined`/`null`, not `''`).
          if (value === '') {
            return true;
          }
          const normalized = value
            .replace(STRIPPED_CONTROL_CHARACTERS, '')
            .toLowerCase();
          return !DANGEROUS_URL_SCHEMES.some((scheme) =>
            normalized.startsWith(scheme),
          );
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must not use a javascript:, data:, vbscript: or file: URL`;
        },
      },
    });
  };
}
