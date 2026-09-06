// Pure helpers for the `GET /files/*` serve path: derive the response headers a
// served object should carry, and verify an object's real first bytes match the
// content type its key claims. No I/O here — the storage client reads the bytes;
// these functions only decide content type / disposition and inspect a buffer,
// so they are trivially unit-testable in isolation.
import {
  DOCUMENT_UPLOAD_TYPES,
  IMAGE_UPLOAD_TYPES,
} from './upload-content-types';

// Reverse of `IMAGE_UPLOAD_TYPES`/`DOCUMENT_UPLOAD_TYPES` (content type ->
// extension): given a key's extension, recover the single content type it must
// be served as. Built once from the same tables the upload path validates
// against, so none of the three can ever drift apart.
const CONTENT_TYPE_BY_EXTENSION: Readonly<Record<string, string>> =
  Object.fromEntries([
    ...Object.entries(IMAGE_UPLOAD_TYPES).map(([contentType, spec]) => [
      spec.extension,
      contentType,
    ]),
    ...Object.entries(DOCUMENT_UPLOAD_TYPES).map(([contentType, spec]) => [
      spec.extension,
      contentType,
    ]),
  ]);

// The number of leading bytes the magic-byte check needs. WEBP is the widest
// image signature: `RIFF....WEBP` spans bytes 0-11, so 16 is a comfortable
// margin for every image AND document type below (PDF's `%PDF-` and the ZIP
// local-file-header XLSX carries both fit well inside it too).
export const MAGIC_BYTE_PREFIX_LENGTH = 16;

/**
 * The content type a storage key must be served as, derived from the key's
 * extension (the extension is server-minted at upload from the validated
 * content type, so it is trustworthy). Returns `null` for a value whose
 * extension is not a known image or document extension.
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
 * images rendering in `<img>` and documents opening in the browser's own PDF/
 * text viewer, while still declaring a disposition (a bare object with no
 * disposition is what browsers are most willing to content-sniff).
 *
 * A document's ORIGINAL filename (what a member actually named their upload,
 * e.g. "lease.pdf") never reaches this header — it is display-only, carried in
 * the message's `attachment.fileName` and rendered as TEXT in the bubble; a
 * download saves under this generated `<uuid>.<ext>` name instead. That is a
 * deliberate, narrow scope trim (see `MessagingCoreService.postMessage`'s
 * `sanitizeDisplayFileName`): baking client-supplied text into a response
 * header safely needs RFC 5987 encoding and an extra message lookup at serve
 * time for no correctness gain, only a cosmetic one.
 */
export function inlineContentDispositionForStorageKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  return `inline; filename="${fileName}"`;
}

/**
 * A best-effort "this looks like text, not a binary payload" check for the two
 * content types with no real magic-byte signature (`text/plain`, `text/csv`):
 * unlike a PNG/PDF/ZIP, a text file's format IS its bytes, so there is no fixed
 * header to assert against. Rejects a NUL byte anywhere in the sampled prefix
 * (the single most common binary tell) and any other control byte outside
 * ordinary whitespace (tab/LF/CR) — a genuine binary payload (an EXE, a JPEG
 * relabelled as `.txt`, …) trips this within the first {@link
 * MAGIC_BYTE_PREFIX_LENGTH} bytes almost always; a legitimate empty file passes
 * trivially (nothing in it contradicts "this is text"). This is a secondary
 * layer, not the primary defence — the primary defence for a text kind is the
 * FORCED `ResponseContentType: text/plain|text/csv` on the presigned GET (see
 * `StorageService.createPresignedDownload`) plus `X-Content-Type-Options:
 * nosniff`, which together stop a mislabelled payload from ever being
 * interpreted as anything executable regardless of what this heuristic misses.
 */
function looksLikeTextPrefix(bytes: Uint8Array): boolean {
  for (const byte of bytes) {
    if (byte === 0x00) return false;
    const isTab = byte === 0x09;
    const isLineFeed = byte === 0x0a;
    const isCarriageReturn = byte === 0x0d;
    const isDelete = byte === 0x7f;
    const isOtherControlByte =
      byte < 0x20 && !isTab && !isLineFeed && !isCarriageReturn;
    if (isOtherControlByte || isDelete) return false;
  }
  return true;
}

/**
 * Whether the first bytes of an object match the content type it declares.
 *
 * The magic-byte check is the server-side backstop for M2: uploads go straight
 * to the bucket via a presigned PUT (the backend never sees the bytes), so a
 * modified client can PUT arbitrary bytes under an allowed content type. A
 * `.png` key whose bytes are actually HTML/JS or a GPS-EXIF-laden original, or
 * a `.pdf` key that is really an executable, is caught here before the object
 * is ever served.
 *
 * `null` content type (unknown extension) yields `false` — the caller treats an
 * unrecognised type as not-validated and 404s, since only the known image and
 * document types are ever minted.
 */
export function magicBytesMatchContentType(
  bytes: Uint8Array,
  contentType: string | null,
): boolean {
  if (!contentType) {
    return false;
  }
  switch (contentType) {
    case 'application/pdf':
      // PDF header: `%PDF-` (25 50 44 46 2D).
      return (
        bytes[0] === 0x25 &&
        bytes[1] === 0x50 &&
        bytes[2] === 0x44 &&
        bytes[3] === 0x46 &&
        bytes[4] === 0x2d
      );
    case 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':
      // XLSX is a ZIP container: local-file-header `PK\x03\x04`, or the
      // empty-archive signature `PK\x05\x06` for a workbook with no sheets.
      return (
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        ((bytes[2] === 0x03 && bytes[3] === 0x04) ||
          (bytes[2] === 0x05 && bytes[3] === 0x06))
      );
    case 'text/plain':
    case 'text/csv':
      return looksLikeTextPrefix(bytes);
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
