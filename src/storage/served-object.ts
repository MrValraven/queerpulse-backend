// Pure helpers for the `GET /files/*` serve path: derive the response headers a
// served object should carry, and verify an object's real first bytes match the
// image type its key claims. No I/O here — the storage client reads the bytes;
// these functions only decide content type / disposition and inspect a buffer,
// so they are trivially unit-testable in isolation.
import { IMAGE_UPLOAD_TYPES } from './upload-content-types';

// Reverse of `IMAGE_UPLOAD_TYPES` (content type -> extension): given a key's
// extension, recover the single image content type it must be served as. Built
// once from the same table the upload path validates against, so the two can
// never drift.
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  Object.fromEntries(
    Object.entries(IMAGE_UPLOAD_TYPES).map(([contentType, spec]) => [
      spec.extension,
      contentType,
    ]),
  );

// The number of leading bytes the magic-byte check needs. WEBP is the widest
// signature: `RIFF....WEBP` spans bytes 0-11, so 16 is a comfortable margin.
export const MAGIC_BYTE_PREFIX_LENGTH = 16;

/**
 * The image content type a storage key must be served as, derived from the key's
 * extension (the extension is server-minted at upload from the validated
 * content type, so it is trustworthy). Returns `null` for a value whose
 * extension is not a known image extension.
 */
export function contentTypeForStorageKey(key: string): string | null {
  const lastDot = key.lastIndexOf('.');
  if (lastDot === -1) {
    return null;
  }
  const extension = key.slice(lastDot);
  return CONTENT_TYPE_BY_EXTENSION[extension] ?? null;
}

/**
 * An `inline` Content-Disposition whose filename is the key's final path segment
 * only — a server-minted `<uuid>.<ext>`, never any client-supplied text — so the
 * value is always header-safe with no escaping required. Serving `inline` keeps
 * images rendering in `<img>` while still declaring a disposition (a bare object
 * with no disposition is what browsers are most willing to content-sniff).
 */
export function inlineContentDispositionForStorageKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  return `inline; filename="${fileName}"`;
}

/**
 * Whether the first bytes of an object match the image content type it declares.
 *
 * The magic-byte check is the server-side backstop for M2: uploads go straight
 * to the bucket via a presigned PUT (the backend never sees the bytes), so a
 * modified client can PUT arbitrary bytes under an `image/*` content type. A
 * `.png` key whose bytes are actually HTML/JS or a GPS-EXIF-laden original is
 * caught here before the object is ever served.
 *
 * `null` content type (unknown extension) yields `false` — the caller treats an
 * unrecognised type as not-validated and 404s, since only the four known image
 * types are ever minted.
 */
export function magicBytesMatchContentType(
  bytes: Uint8Array,
  contentType: string | null,
): boolean {
  if (!contentType) {
    return false;
  }
  switch (contentType) {
    case 'image/jpeg':
      // JPEG SOI + marker: FF D8 FF.
      return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    case 'image/png':
      // PNG signature: 89 50 4E 47 0D 0A 1A 0A.
      return (
        bytes[0] === 0x89 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x4e &&
        bytes[3] === 0x47 &&
        bytes[4] === 0x0d &&
        bytes[5] === 0x0a &&
        bytes[6] === 0x1a &&
        bytes[7] === 0x0a
      );
    case 'image/gif':
      // GIF87a or GIF89a: 47 49 46 38 (37|39) 61.
      return (
        bytes[0] === 0x47 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x38 &&
        (bytes[4] === 0x37 || bytes[4] === 0x39) &&
        bytes[5] === 0x61
      );
    case 'image/webp':
      // RIFF container with a WEBP fourCC: `52 49 46 46 .. .. .. .. 57 45 42 50`.
      return (
        bytes[0] === 0x52 &&
        bytes[1] === 0x49 &&
        bytes[2] === 0x46 &&
        bytes[3] === 0x46 &&
        bytes[8] === 0x57 &&
        bytes[9] === 0x45 &&
        bytes[10] === 0x42 &&
        bytes[11] === 0x50
      );
    default:
      return false;
  }
}
