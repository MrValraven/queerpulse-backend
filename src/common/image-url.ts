import { InternalServerErrorException, Logger } from '@nestjs/common';
import { isStorageKey, storageKeyOwnerId } from '../storage/storage-key';
import { isMessageAttachmentReference } from '../storage/message-attachment-reference';
import { mediaReferenceVersion } from '../storage/media-reference-version';
import { isPublicMediaReference } from '../storage/public-media-reference';

const logger = new Logger('ImageUrl');

// Every image field in the database holds one of two things:
//
//   a storage key      — everything uploaded through `/uploads/presign`
//   an absolute URL    — Google OAuth avatars (`users.service.ts`) and the
//                        seeded Unsplash magazine authors
//
// Railway Buckets are private, so a key is not directly fetchable; it becomes a
// URL to our own `GET /files/*` route, which authorizes and redirects. External
// URLs are already fetchable and pass through.
//
// A message attachment sent as a business, persona or company is rendered by
// a third kind of value, its opaque reference (`messages/<messageId>/0`, see
// `storage/message-attachment-reference.ts`). It resolves to the same
// `GET /files/*` route, which serves it by message after authorizing the
// requester, so the uploader's user id inside the storage key never leaves
// the server.
//
// SEC-01 / SEC-04: a forum photo, a listing gallery or cover photo and a
// listing review photo shown to a reader who must not learn the uploader are
// rendered by a fourth kind of value, a public media reference
// (`forum-posts/<postId>/photos/<index>` and its siblings, see
// `storage/public-media-reference.ts`). It resolves to the same route, which
// looks the key up from the row and streams the bytes.
//
// Anything that is neither is dropped rather than forwarded. These columns have
// never validated their input, so a `javascript:` or `data:` URI could have
// been persisted and would otherwise be rendered in another member's browser.
//
// WHY A MODULE-LEVEL SINGLETON rather than an injectable service: the response
// mappers that call this are exported plain functions, not Nest providers, so
// they cannot receive a dependency. `CommonModule` sets the base URL once at
// bootstrap; it is a static config value that never changes at runtime.

let apiBaseUrl: string | null = null;

/** Called once during bootstrap by `CommonModule`. */
export function setImageUrlBase(nextApiBaseUrl: string): void {
  apiBaseUrl = nextApiBaseUrl.replace(/\/$/, '');
}

/** Restores the uninitialised state so specs do not leak into one another. */
export function resetImageUrlBaseForTesting(): void {
  apiBaseUrl = null;
}

/**
 * PRD-423: an absolute URL for a VERSION_NEUTRAL route of this API, built
 * from the same base `toImageUrl` uses, for a server-minted image address
 * that is no storage key (a matched Go together chat's member avatar route).
 * `path` carries no leading slash. Fails like `toImageUrl` when the base was
 * never wired.
 */
export function apiUrlFor(path: string): string {
  if (!apiBaseUrl) {
    logger.error(
      'Image URL base is not configured: setImageUrlBase() was never called',
    );
    throw new InternalServerErrorException('Service temporarily unavailable');
  }
  return `${apiBaseUrl}/${path}`;
}

export function toImageUrl(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (
    isStorageKey(value) ||
    isMessageAttachmentReference(value) ||
    isPublicMediaReference(value)
  ) {
    if (!apiBaseUrl) {
      // Reaching this means a mapper ran before bootstrap wired the base URL.
      // Returning a bare key would render as a broken relative image; failing
      // loudly surfaces the wiring bug at the first request instead. This runs
      // inside request-path response mappers, so throw an HttpException Nest can
      // render (keeping the wiring detail in the log, off the wire).
      logger.error(
        'Image URL base is not configured — setImageUrlBase() was never called',
      );
      throw new InternalServerErrorException('Service temporarily unavailable');
    }
    return `${apiBaseUrl}/files/${value}`;
  }
  if (value.startsWith('https://')) {
    return value;
  }
  return null;
}

/**
 * Reverse of `toImageUrl` for a value arriving on a WRITE.
 *
 * Frontend edit forms are seeded with the RESOLVED display URL `toImageUrl`
 * produced (`<apiBaseUrl>/files/<key>`), not the raw storage key, and several
 * re-send it on save. Persisting that derived URL would bake THIS environment's
 * origin into the column, and — because a dev API base is `http://…` — the next
 * `toImageUrl` read would fail its `https://`-only check and return `null`,
 * blanking the image. So collapse our OWN resolved URLs back to the bare key
 * before persisting, keeping the storage layer canonical (keys, not URLs) and
 * making the round-trip idempotent.
 *
 * Only `<apiBaseUrl>/files/<key>` whose tail parses as one of our storage keys
 * is rewritten. Bare keys, external `https://` URLs, and arbitrary text are
 * returned unchanged (so `isStorageKey`/`toImageUrl`/ownership checks still see
 * them verbatim). When the base URL is unset (e.g. a unit test that never
 * bootstraps it) the input is returned as-is.
 */
export function storageKeyFromImageUrl(value: string): string {
  if (!apiBaseUrl) {
    return value;
  }
  const filesPrefix = `${apiBaseUrl}/files/`;
  if (!value.startsWith(filesPrefix)) {
    return value;
  }
  const key = value.slice(filesPrefix.length);
  return isStorageKey(key) ? key : value;
}

/**
 * Final fix F1 (C1): the opaque message attachment reference a WRITE carries,
 * or `null` when it carries none. A forward of a business, persona or company
 * attachment arrives as the resolved URL `toImageUrl` produced
 * (`<apiBaseUrl>/files/messages/<messageId>/0`), or as the bare reference, and
 * this collapses either back to the reference. Every other value, including a
 * storage key and its resolved URL, returns `null`.
 */
export function messageAttachmentReferenceFromImageUrl(
  value: string,
): string | null {
  if (isMessageAttachmentReference(value)) {
    return value;
  }
  if (!apiBaseUrl) {
    return null;
  }
  const filesPrefix = `${apiBaseUrl}/files/`;
  if (!value.startsWith(filesPrefix)) {
    return null;
  }
  const reference = value.slice(filesPrefix.length);
  return isMessageAttachmentReference(reference) ? reference : null;
}

/**
 * SEC-01 / SEC-04: the public media reference a WRITE carries, or `null` when
 * it carries none. An edit form seeded from a read that rendered a photo by
 * reference (a reviewer editing their own review, say) sends back either the
 * resolved URL `<apiBaseUrl>/files/<reference>` or the bare reference, and
 * this collapses both to the reference so `StorageKeyOwnershipInterceptor`
 * can look the stored key up. Every other value returns `null`.
 */
export function publicMediaReferenceFromImageUrl(value: string): string | null {
  if (isPublicMediaReference(withoutQuery(value))) {
    return withoutQuery(value);
  }
  if (!apiBaseUrl) {
    return null;
  }
  const filesPrefix = `${apiBaseUrl}/files/`;
  if (!value.startsWith(filesPrefix)) {
    return null;
  }
  // The `?v=` version token every reference URL carries is dropped: it names
  // the photo's version, and the row is what the write needs.
  const reference = withoutQuery(value.slice(filesPrefix.length));
  return isPublicMediaReference(reference) ? reference : null;
}

/** `value` up to its first `?`. */
function withoutQuery(value: string): string {
  const queryStart = value.indexOf('?');
  return queryStart === -1 ? value : value.slice(0, queryStart);
}

/**
 * SEC-04: a stored image value as a PUBLIC read renders it. A member storage
 * key names its uploader (`<prefix>/<uploaderUserId>/...`), so it is rendered
 * as `reference`, the opaque name of the row holding it
 * (`storage/public-media-reference.ts`), dropped to `null` when the row id
 * could not form one. The URL carries `?v=<token>`, a short HMAC of the
 * reference and the stored value (`storage/media-reference-version.ts`), so
 * replacing the photo gives a new URL and one key on two surfaces gets two
 * tokens. An external URL, or a key that names nobody, passes through
 * `toImageUrl` unchanged, since it identifies no one.
 */
export function toImageUrlByReference(
  storedValue: string | null | undefined,
  reference: string | null,
): string | null {
  if (!storedValue || storageKeyOwnerId(storedValue) === null) {
    return toImageUrl(storedValue);
  }
  const url = toImageUrl(reference);
  return url && reference
    ? `${url}?v=${mediaReferenceVersion(storedValue, reference)}`
    : null;
}

/**
 * `<apiBaseUrl>/files/<key>` for a storage key, or `null` while the base is
 * not configured (a spec that never bootstraps it). For a write path that
 * wants a value to look exactly as a read rendered it, which
 * `storageKeyFromImageUrl` then collapses back.
 */
export function filesUrlOrNull(storageKey: string): string | null {
  return apiBaseUrl && isStorageKey(storageKey)
    ? `${apiBaseUrl}/files/${storageKey}`
    : null;
}
