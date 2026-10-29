import {
  DOCUMENT_UPLOAD_TYPES,
  IMAGE_UPLOAD_TYPES,
  STUDIO_AUDIO_UPLOAD_TYPES,
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

// Studio audio keys stay out of this pattern on purpose: `GET /files/*` never
// serves them (a track streams through a presigned GET after the grant
// check), and their middle segment is random, so the ownership check below
// must never read it as a user id. `isStudioAudioKey` is their shape check.
const UPLOAD_PREFIXES = Object.values(UPLOAD_KIND_SPECS)
  .filter((spec) => spec !== UPLOAD_KIND_SPECS.studio_audio)
  .map((spec) => spec.prefix);

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
 * Studio discovery: the prefix of a SCENE-SCOPED key:
 * `studio-scene/<uuid>/<uuid><ext>`.
 *
 * Staff upload a scene cover as a `work-image`, whose key names the staff
 * member, and a scene page is public. So the server copies that upload
 * under this prefix (`StorageService.copyObjectToStudioSceneScope`), where
 * both segments are random, and stores the copy. Nothing presigns under it.
 * `GET /files/*` serves one only while a `studio_scenes` row names it as its
 * cover, and the orphan sweep keeps exactly those, so a copy whose write
 * rolled back is never served and is reclaimed.
 */
export const STUDIO_SCENE_SCOPED_PREFIX = 'studio-scene';

/** The read policy of a scene-scoped key: public like the `work-image` it
 *  is copied from, with the same 10 MB cap. */
export const STUDIO_SCENE_SCOPED_KIND_SPEC: UploadKindSpec = {
  prefix: STUDIO_SCENE_SCOPED_PREFIX,
  maxBytes: 10 * 1024 * 1024,
  requiresSession: false,
};

const STUDIO_SCENE_SCOPED_KEY_PATTERN = new RegExp(
  `^${escapeForRegex(STUDIO_SCENE_SCOPED_PREFIX)}/${UUID_SEGMENT}/${UUID_SEGMENT}(${IMAGE_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

/** Whether a value is a scene-scoped key (`studio-scene/<uuid>/<uuid><ext>`). */
export function isStudioSceneScopedKey(value: string): boolean {
  return (
    typeof value === 'string' && STUDIO_SCENE_SCOPED_KEY_PATTERN.test(value)
  );
}

/**
 * Studio landing v2: the prefix of a LANDING-SCOPED key:
 * `studio-landing/<uuid>/<uuid><ext>`.
 *
 * Staff upload a Studio page photo as a `work-image`, whose key names the
 * staff member, and the Studio page is public. So the server copies that
 * upload under this prefix, where both segments are random, and stores the
 * copy. Nothing presigns under it. `GET /files/*` serves one only while a
 * `studio_landing_photos` row stores it, and the orphan sweep keeps exactly
 * those, so a copy whose write rolled back is never served and is reclaimed.
 */
export const STUDIO_LANDING_SCOPED_PREFIX = 'studio-landing';

/** The read policy of a landing-scoped key: public like the `work-image` it
 *  is copied from, with the same 10 MB cap. */
export const STUDIO_LANDING_SCOPED_KIND_SPEC: UploadKindSpec = {
  prefix: STUDIO_LANDING_SCOPED_PREFIX,
  maxBytes: 10 * 1024 * 1024,
  requiresSession: false,
};

const STUDIO_LANDING_SCOPED_KEY_PATTERN = new RegExp(
  `^${escapeForRegex(STUDIO_LANDING_SCOPED_PREFIX)}/${UUID_SEGMENT}/${UUID_SEGMENT}(${IMAGE_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

/** Whether a value is a landing-scoped key
 *  (`studio-landing/<uuid>/<uuid><ext>`). */
export function isStudioLandingScopedKey(value: string): boolean {
  return (
    typeof value === 'string' && STUDIO_LANDING_SCOPED_KEY_PATTERN.test(value)
  );
}

/**
 * Resolves a storage key to the upload kind that owns it, or `null` when the
 * value is not a well-formed key for a known kind. A persona-scoped key
 * resolves to `PERSONA_SCOPED_KIND_SPEC`, and a scene-scoped key to
 * `STUDIO_SCENE_SCOPED_KIND_SPEC`.
 */
export function parseStorageKey(value: string): UploadKindSpec | null {
  if (typeof value !== 'string') {
    return null;
  }
  if (PERSONA_SCOPED_KEY_PATTERN.test(value)) {
    return PERSONA_SCOPED_KIND_SPEC;
  }
  if (STUDIO_SCENE_SCOPED_KEY_PATTERN.test(value)) {
    return STUDIO_SCENE_SCOPED_KIND_SPEC;
  }
  if (STUDIO_LANDING_SCOPED_KEY_PATTERN.test(value)) {
    return STUDIO_LANDING_SCOPED_KIND_SPEC;
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
 * The same holds for a scene-scoped key (`isStudioSceneScopedKey`) and a
 * landing-scoped key (`isStudioLandingScopedKey`).
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

const STUDIO_AUDIO_EXTENSIONS = Object.values(STUDIO_AUDIO_UPLOAD_TYPES).map(
  (spec) => spec.extension,
);

/** `studio-audio/<uuid>/<uuid>.mp3|.m4a`, as `presignStudioAudioUpload` mints it. */
export const STUDIO_AUDIO_KEY_PATTERN = new RegExp(
  `^${escapeForRegex(UPLOAD_KIND_SPECS.studio_audio.prefix)}/${UUID_SEGMENT}/${UUID_SEGMENT}(${STUDIO_AUDIO_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

/** Whether a value is a Studio audio key. */
export function isStudioAudioKey(value: string): boolean {
  return typeof value === 'string' && STUDIO_AUDIO_KEY_PATTERN.test(value);
}

/** The content type a Studio audio key's extension stands for, or null. */
export function studioAudioContentTypeForKey(value: string): string | null {
  if (!isStudioAudioKey(value)) {
    return null;
  }
  const extension = value.slice(value.lastIndexOf('.'));
  const matchingEntry = Object.entries(STUDIO_AUDIO_UPLOAD_TYPES).find(
    ([, spec]) => spec.extension === extension,
  );
  return matchingEntry ? matchingEntry[0] : null;
}

/**
 * Contract 4.7: the prefix of a KEPT audio copy, `studio-kept-audio/<uuid>.mp3|.m4a`.
 * A persona unlink gives its confirmed buyers a private copy of each bought
 * track under a key of its own, so a buyer's download URL never matches the
 * re-keyed track's stream URL. The key has one random segment and no owner.
 * `GET /files/*` never serves it (it is outside `STORAGE_KEY_PATTERN`), and
 * it stays out of `STUDIO_AUDIO_KEY_PATTERN`, which the upload confirm reads.
 */
export const STUDIO_KEPT_AUDIO_PREFIX = 'studio-kept-audio';

export const STUDIO_KEPT_AUDIO_KEY_PATTERN = new RegExp(
  `^${escapeForRegex(STUDIO_KEPT_AUDIO_PREFIX)}/${UUID_SEGMENT}(${STUDIO_AUDIO_EXTENSIONS.map(escapeForRegex).join('|')})$`,
);

/** Whether a value is a kept audio copy key. */
export function isStudioKeptAudioKey(value: string): boolean {
  return typeof value === 'string' && STUDIO_KEPT_AUDIO_KEY_PATTERN.test(value);
}

/** Whether a presigned download may sign the key: Studio audio or a kept copy. */
export function isStudioDownloadableAudioKey(value: string): boolean {
  return isStudioAudioKey(value) || isStudioKeptAudioKey(value);
}
