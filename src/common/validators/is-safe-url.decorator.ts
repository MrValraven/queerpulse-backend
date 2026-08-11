import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

// Every ASCII control character and space (U+0000–U+0020). A browser ignores
// these when resolving a URL's scheme, so `  JavaScript:` and `java\tscript:`
// both execute — we strip them out before testing the scheme rather than let a
// naive check be fooled by them (same defence as
// `is-safe-external-url.decorator.ts`).
// eslint-disable-next-line no-control-regex
const STRIPPED_CONTROL_CHARACTERS = /[\u0000-\u0020]/g;

// A URL scheme prefix: `scheme:` where scheme starts with a letter and is
// followed by letters/digits/`+`/`-`/`.` (RFC 3986). Matched on the
// control-stripped, lowercased value so smuggled whitespace/case can't hide it.
const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/;

// The only two schemes a member-editable link field may carry: a secure web
// URL and an email link. `http:` is refused too — it would be blocked as mixed
// content on an https page anyway, and accepting it invites a downgrade (mirrors
// `is-image-reference.decorator.ts`).
const ALLOWED_SCHEME_PREFIXES = ['https://', 'mailto:'];

/**
 * The pure predicate behind {@link IsSafeUrl}, exported so other validators can
 * reuse the exact same scheme-allowlist logic without re-deriving it (e.g. the
 * nested `structured.links[].urlOrHandle` check in `replace-items.dto.ts`). See
 * {@link IsSafeUrl}'s doc for the accept/reject rules; `allowHandle` mirrors the
 * `{ allowHandle: true }` option.
 */
export function isSafeUrlValue(value: unknown, allowHandle = false): boolean {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'string') {
    return false;
  }
  // An empty string means "no link", exactly like `null` above.
  if (value === '') {
    return true;
  }
  const normalized = value
    .replace(STRIPPED_CONTROL_CHARACTERS, '')
    .toLowerCase();
  if (URL_SCHEME_PATTERN.test(normalized)) {
    // Carries a scheme — accept only the two safe ones.
    return ALLOWED_SCHEME_PREFIXES.some((prefix) => normalized.startsWith(prefix));
  }
  // No scheme: a bare handle/host is fine for social fields, refused for the
  // strict link fields.
  return allowHandle;
}

/**
 * A member-editable link field that is rendered as an `<a href>`: a persona's
 * contact-CTA URL, a portfolio item's `url`/`ticketUrl`, a social link's
 * `urlOrHandle`. These were previously bare `@IsString()`, so a client could
 * persist `javascript:steal()`, a `data:` document, or a `vbscript:` payload
 * that another member's browser would run the moment the value was rendered as
 * a link.
 *
 * This is an *allowlist* (unlike the blocklist `IsSafeExternalUrl` used for the
 * listings `website`/`link` fields): a value that carries a URL scheme is
 * accepted ONLY when that scheme is `https://` or `mailto:`. Every other scheme
 * — `javascript:`, `data:`, `vbscript:`, `http:`, `file:`, … — is rejected.
 *
 * `{ allowHandle: true }` additionally accepts a scheme-LESS string (a bare
 * `@handle` or `soundcloud.com/artist`) — used for social `urlOrHandle`, where
 * the frontend renders a protocol-less value behind an `https://` prefix. A
 * scheme-less value can never be executed as a `javascript:`/`data:` document
 * (a browser only treats a string as a scripting URL when it actually starts
 * with that scheme), so admitting it is safe. Without the option a scheme-less
 * value is rejected — a CTA/item URL must be a real link, not a bare handle.
 */
export function IsSafeUrl(
  options: { allowHandle?: boolean } = {},
  validationOptions?: ValidationOptions,
) {
  const allowHandle = options.allowHandle ?? false;
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isSafeUrl',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          // The scheme-allowlist rule lives in the shared `isSafeUrlValue`
          // helper (also reused by the nested `structured.links` validator) so
          // there is a single source of truth for "what is a safe link".
          return isSafeUrlValue(value, allowHandle);
        },
        defaultMessage(args: ValidationArguments) {
          return allowHandle
            ? `${args.property} must be an https:// URL, a mailto: link, or a bare handle`
            : `${args.property} must be an https:// URL or a mailto: link`;
        },
      },
    });
  };
}
