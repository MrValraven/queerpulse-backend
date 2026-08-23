import {
  ValidationOptions,
  buildMessage,
  registerDecorator,
} from 'class-validator';

// The only two schemes a community resource may point at. Everything else is
// refused, `javascript:` and `data:` explicitly among them: a resource URL is
// user-supplied content that the shelf renders as a real anchor, so a scheme
// that executes in the reader's page (`javascript:`) or that carries a whole
// document inline (`data:text/html,...`) is a stored XSS vector rather than a
// link. `new URL()` parses both of those perfectly happily, so parsing alone
// proves nothing: this allowlist is the actual check.
const ALLOWED_URL_PROTOCOLS = new Set(['http:', 'https:']);

/**
 * Whether a value is an absolute `http:`/`https:` URL with a host.
 *
 * Deliberately not class-validator's `@IsUrl()`: that validator is built on a
 * permissive pattern with a long tail of options, and it has historically
 * been the wrong tool for "is this safe to render as a link". Parsing with
 * the platform `URL` and then allowlisting the protocol is both stricter and
 * easier to read. The parser also normalises away the tab/newline smuggling
 * trick (`java\nscript:alert(1)`), which lands back on the protocol check.
 */
export function isHttpUrl(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const candidate = value.trim();
  if (!candidate) return false;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch {
    return false;
  }
  if (!ALLOWED_URL_PROTOCOLS.has(parsed.protocol)) return false;
  // A protocol-only value (`http:`) parses but points nowhere.
  return parsed.hostname.length > 0;
}

/**
 * `@IsHttpUrl()` — DTO decorator wrapping `isHttpUrl`. Mirrors the shape of
 * `@IsImageReference()` (`src/common/validators/is-image-reference.decorator.ts`),
 * which does the same job for image references and rejects the same schemes.
 *
 * `@IsSafeExternalUrl()` is the module's other neighbour and is deliberately
 * looser: it blocklists dangerous schemes while still accepting `''` and
 * protocol-less input (`example.com`), because the member-editable website
 * fields it guards need both. A resource URL is a required absolute link the
 * shelf renders directly, so it gets the allowlist instead.
 */
export function IsHttpUrl(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isHttpUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate: (value: unknown) => isHttpUrl(value),
        defaultMessage: buildMessage(
          (eachPrefix) =>
            `${eachPrefix}$property must be an absolute http:// or https:// URL`,
          validationOptions,
        ),
      },
    });
  };
}
