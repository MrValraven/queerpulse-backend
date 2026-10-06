import {
  DOCUMENT_UPLOAD_TYPES,
  IMAGE_UPLOAD_TYPES,
} from './upload-content-types';
import { UPLOAD_KIND_SPECS, UploadKindSpec } from './upload-kinds';

// The single authority on what a storage key looks like. Both alternations are
// derived from the tables that already own them, so adding an upload kind or an
// image type never needs a second edit here.
//
// This regex is the path-traversal boundary for `GET /files/*`: the segment
// pattern admits only hex and dashes, so `..` can never appear in a key that
// parses. Everything else — unknown prefixes, odd extensions, probe strings —
// is rejected the same way, and the caller turns that into a 404 so the route
// never reveals which keys exist.

const UPLOAD_PREFIXES = Object.values(UPLOAD_KIND_SPECS).map(
  (spec) => spec.prefix,
);

const IMAGE_EXTENSIONS = Object.values(IMAGE_UPLOAD_TYPES).map(
  (spec) => spec.extension,
);

const DOCUMENT_EXTENSIONS = Object.values(DOCUMENT_UPLOAD_TYPES).map(
  (spec) => spec.extension,
);

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const UUID_SEGMENT =
  '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

// Extension matching is case-sensitive (only lowercase accepted) while UUID
// hex-digit matching accepts both cases. This asymmetry is safe: the upload
// controller always emits lowercase extensions, so uppercase `.JPG` is correctly
// rejected as a malformed key.
//
// The middle segment (the owner's user id, minted as `user.userId` in
// `uploads.controller.ts`) is captured too — `storageKeyOwnerId` below reuses
// this same pattern rather than duplicating it, so the ownership check can
// never drift out of sync with what actually parses as a key.
const KNOWN_EXTENSIONS = [...IMAGE_EXTENSIONS, ...DOCUMENT_EXTENSIONS];

const STORAGE_KEY_PATTERN = new RegExp(
  `^(${UPLOAD_PREFIXES.map(escapeForRegex).join('|')})/(${UUID_SEGMENT})/${UUID_SEGMENT}(${KNOWN_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

const SPECS_BY_PREFIX = new Map<string, UploadKindSpec>(
  Object.values(UPLOAD_KIND_SPECS).map((spec) => [spec.prefix, spec]),
);

/**
 * The prefix of a PERSONA-SCOPED key: `persona/<uuid>/<uuid><ext>`.
 *
 * Every other key embeds its uploader's user id as the middle segment, and
 * `toImageUrl` publishes the key as `/files/<key>`. On an unlinked
 * (pseudonymous) persona that segment would tie the persona to the person
 * behind it: the same id appears in their own member avatar URL. So an
 * unlinked persona's images live under this prefix, where both segments are
 * random and say nothing about who uploaded the bytes or which persona holds
 * them. The two-segment shape is kept so a persona key parses, routes and
 * splits like every other key.
 *
 * Nothing presigns under this prefix: it is not an `UploadKind`, so the
 * upload routes never mint one. The server writes these keys itself, by
 * copying a member's own upload (`StorageService.copyObjectToPersonaScope`)
 * or by storing server-fetched art (`StorageService.putPersonaServerObject`),
 * and records each one in `persona_storage_keys`, which is what authorizes
 * and serves it.
 */
export const PERSONA_SCOPED_PREFIX = 'persona';

/**
 * The read policy of a persona-scoped key. Public like the three kinds a
 * persona image comes from (`avatar`, `persona-cover`, `work-image`): a
 * published persona page is reachable signed out and by link unfurlers.
 * 10 MB is the largest of those three caps.
 */
export const PERSONA_SCOPED_KIND_SPEC: UploadKindSpec = {
  prefix: PERSONA_SCOPED_PREFIX,
  maxBytes: 10 * 1024 * 1024,
  requiresSession: false,
};

// Images only: a persona holds avatars, covers and item images.
const PERSONA_SCOPED_KEY_PATTERN = new RegExp(
  `^${escapeForRegex(PERSONA_SCOPED_PREFIX)}/${UUID_SEGMENT}/${UUID_SEGMENT}(${IMAGE_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

/** Whether a value is a persona-scoped key (`persona/<uuid>/<uuid><ext>`). */
export function isPersonaScopedKey(value: string): boolean {
  return typeof value === 'string' && PERSONA_SCOPED_KEY_PATTERN.test(value);
}

/** Whether an image extension (`.jpg`) may end a persona-scoped key. */
export function isPersonaScopedExtension(extension: string): boolean {
  return IMAGE_EXTENSIONS.includes(extension);
}

/**
 * Resolves a storage key to the upload kind that owns it, or `null` when the
 * value is not a well-formed key for a known kind. A persona-scoped key
 * resolves to `PERSONA_SCOPED_KIND_SPEC`.
 */
export function parseStorageKey(value: string): UploadKindSpec | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (PERSONA_SCOPED_KEY_PATTERN.test(value)) {
    return PERSONA_SCOPED_KIND_SPEC;
  }
  const match = STORAGE_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  const prefix = match[1];
  if (prefix === undefined) {
    return null;
  }
  return SPECS_BY_PREFIX.get(prefix) ?? null;
}

/** Whether a stored image value is one of our keys rather than an external URL. */
export function isStorageKey(value: string): boolean {
  return parseStorageKey(value) !== null;
}

/**
 * Extracts the owner user id embedded in a storage key
 * (`<prefix>/<ownerUserId>/<uuid><ext>`), or `null` when the value is not a
 * well-formed key. Reuses `STORAGE_KEY_PATTERN` — the sole authority on what a
 * key looks like — rather than a second hand-rolled pattern, so this can never
 * accept something `parseStorageKey` would reject (or vice versa).
 *
 * A persona-scoped key has no owner segment and resolves to `null` here.
 * A caller doing an ownership check must therefore test
 * `isPersonaScopedKey` first: `null` alone reads as "not one of our keys".
 */
export function storageKeyOwnerId(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = STORAGE_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return match[2] ?? null;
}
