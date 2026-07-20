import { IMAGE_UPLOAD_TYPES } from './upload-content-types';
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

function escapeForRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const UUID_SEGMENT =
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
const STORAGE_KEY_PATTERN = new RegExp(
  `^(${UPLOAD_PREFIXES.map(escapeForRegex).join('|')})/(${UUID_SEGMENT})/${UUID_SEGMENT}(${IMAGE_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

const SPECS_BY_PREFIX = new Map<string, UploadKindSpec>(
  Object.values(UPLOAD_KIND_SPECS).map((spec) => [spec.prefix, spec]),
);

/**
 * Resolves a storage key to the upload kind that owns it, or `null` when the
 * value is not a well-formed key for a known kind.
 */
export function parseStorageKey(value: string): UploadKindSpec | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = STORAGE_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return SPECS_BY_PREFIX.get(match[1]) ?? null;
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
 */
export function storageKeyOwnerId(value: string): string | null {
  if (typeof value !== 'string') {
    return null;
  }
  const match = STORAGE_KEY_PATTERN.exec(value);
  if (!match) {
    return null;
  }
  return match[2];
}
