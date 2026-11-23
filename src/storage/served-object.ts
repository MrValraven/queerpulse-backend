// Pure helpers for the `GET /files/*` serve path: derive the response headers a
// served object should carry, and verify an object's real first bytes match the
// content type its key claims. No I/O here — the storage client reads the bytes;
// these functions only decide content type / disposition and inspect a buffer,
// so they are trivially unit-testable in isolation.
import {
  DOCUMENT_UPLOAD_TYPES,
  IMAGE_UPLOAD_TYPES,
  VJ_CLIP_UPLOAD_TYPES,
} from './upload-content-types';
import { parseStorageKey } from './storage-key';
import { UPLOAD_KIND_SPECS } from './upload-kinds';

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
    ...Object.entries(VJ_CLIP_UPLOAD_TYPES).map(([contentType, spec]) => [
      spec.extension,
      contentType,
    ]),
  ]);

// The number of leading bytes the magic-byte check needs. WEBP is the widest
// image signature: `RIFF....WEBP` spans bytes 0-11, so 16 is a comfortable
// margin for every image AND document type below (PDF's `%PDF-` and the ZIP
// local-file-header XLSX carries both fit well inside it too, and both video
// signatures).
export const MAGIC_BYTE_PREFIX_LENGTH = 16;

// Studio audio reads more: an MP3 may carry padding or junk ahead of its
// first frame header, so its check scans this many leading bytes for one.
export const AUDIO_MAGIC_BYTE_PREFIX_LENGTH = 64;

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
 * An `attachment` Content-Disposition under the same server-minted
 * `<uuid>.<ext>` filename as {@link inlineContentDispositionForStorageKey}.
 * Signed into the presigned GET when a member explicitly asks to SAVE an image
 * (`/files/<key>?download=1`), so the browser downloads it instead of rendering
 * it. A cross-origin `<a download>` is ignored by browsers, so this header is
 * the only thing that turns the bucket response into a download.
 */
export function attachmentContentDispositionForStorageKey(key: string): string {
  const lastSlash = key.lastIndexOf('/');
  const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);
  return `attachment; filename="${fileName}"`;
}

/**
 * The disposition to sign into a presigned GET for a key (PRD-369). A
 * `message-document` is a file from another member, so it is always signed as
 * an `attachment` and never renders inline in the bucket's origin; every other
 * kind (images) keeps {@link inlineContentDispositionForStorageKey}. The
 * filename stays the server-minted `<uuid>.<ext>`, which needs no escaping.
 */
export function contentDispositionForStorageKey(key: string): string {
  if (parseStorageKey(key) === UPLOAD_KIND_SPECS['message-document']) {
    const lastSlash = key.lastIndexOf('/');
    const fileName = lastSlash === -1 ? key : key.slice(lastSlash + 1);
    return `attachment; filename="${fileName}"`;
  }
  return inlineContentDispositionForStorageKey(key);
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
 * `.png` key whose bytes are actually HTML/JS, or a `.pdf` key that is really
 * an executable, is caught here before the object is ever served.
 *
 * This checks the SIGNATURE alone. It says nothing about metadata: an
 * untouched camera JPEG carries a valid signature. The GPS check is
 * {@link jpegCarriesGpsLocation} (SEC-43).
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
    case 'video/mp4':
      // ISO base media: `ftyp` at bytes 4..7, and a major brand that is not
      // `qt  ` (a QuickTime MOV carries the same box).
      return hasFtypBox(bytes) && !isQuickTimeBrand(bytes);
    case 'video/webm':
      // EBML header: 1A 45 DF A3. A Matroska file carries the same header.
      return (
        bytes[0] === 0x1a &&
        bytes[1] === 0x45 &&
        bytes[2] === 0xdf &&
        bytes[3] === 0xa3
      );
    case 'audio/mpeg':
      // Studio audio: an ID3v2 tag at byte 0, or a Layer III frame header
      // anywhere in the bytes read (an encoder may pad ahead of the first
      // frame). The attach parse stays the authoritative check; this one
      // only refuses what can be no MP3 at all.
      return hasId3v2Tag(bytes) || hasMpegLayer3FrameHeader(bytes);
    case 'audio/mp4':
      // Studio audio (`.m4a`): any ISO base media `ftyp` box except the
      // QuickTime `qt  ` brand, the rule `video/mp4` uses. Encoders write
      // many brands (`M4A `, `mp42`, `isom`, `3gp4`, `dash`, `iso5`), and the
      // attach parse checks the codec itself.
      return hasFtypBox(bytes) && !isQuickTimeBrand(bytes);
    default:
      return false;
  }
}

// `ID3` followed by a major version of 2, 3 or 4 (ID3v2.2 to ID3v2.4).
function hasId3v2Tag(bytes: Uint8Array): boolean {
  const majorVersion = bytes[3];
  return (
    bytes[0] === 0x49 &&
    bytes[1] === 0x44 &&
    bytes[2] === 0x33 &&
    majorVersion !== undefined &&
    majorVersion >= 2 &&
    majorVersion <= 4
  );
}

// Whether an MPEG audio Layer III frame header starts at any offset of
// `bytes`.
function hasMpegLayer3FrameHeader(bytes: Uint8Array): boolean {
  for (let offset = 0; offset + 3 <= bytes.length; offset += 1) {
    if (isMpegLayer3FrameHeaderAt(bytes, offset)) return true;
  }
  return false;
}

// An MPEG audio frame header for Layer III at `offset`: 11 sync bits, a
// version that is not the reserved `01`, layer bits `01`, a bitrate index
// that is not the invalid `1111` and a sample rate index that is not the
// reserved `11`. An ADTS AAC stream shares the sync bits and carries layer
// `00`, so it fails.
function isMpegLayer3FrameHeaderAt(bytes: Uint8Array, offset: number): boolean {
  const secondByte = bytes[offset + 1];
  const thirdByte = bytes[offset + 2];
  if (
    bytes[offset] !== 0xff ||
    secondByte === undefined ||
    thirdByte === undefined
  )
    return false;
  const hasSyncBits = (secondByte & 0xe0) === 0xe0;
  const versionBits = (secondByte >> 3) & 0x03;
  const layerBits = (secondByte >> 1) & 0x03;
  const bitrateIndex = (thirdByte >> 4) & 0x0f;
  const sampleRateIndex = (thirdByte >> 2) & 0x03;
  return (
    hasSyncBits &&
    versionBits !== 0x01 &&
    layerBits === 0x01 &&
    bitrateIndex !== 0x0f &&
    sampleRateIndex !== 0x03
  );
}

function hasFtypBox(bytes: Uint8Array): boolean {
  return (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  );
}

/**
 * Whether the first bytes are an ISO base media header whose major brand is
 * `qt  ` (a QuickTime MOV). The VJ clip create uses it to name the MOV format.
 */
export function isQuickTimeBrand(bytes: Uint8Array): boolean {
  return (
    hasFtypBox(bytes) &&
    bytes[8] === 0x71 &&
    bytes[9] === 0x74 &&
    bytes[10] === 0x20 &&
    bytes[11] === 0x20
  );
}

// SEC-43: how many leading bytes a JPEG's metadata check reads. EXIF lives in
// an APP1 segment, which encoders write right after the start-of-image marker
// (after an optional APP0/JFIF segment), and one segment is at most 64 KiB,
// so for an ordinary camera file these bytes hold the IFD0 directory that
// points at a GPS block.
//
// Known gaps, accepted because a browser upload is re-encoded and carries no
// metadata at all, so only a client that skipped that step reaches them:
//  - an APP1 that starts after the first 64 KiB (behind large APPn segments)
//    is not read;
//  - location written as XMP (an APP1 with an `http://ns.adobe.com/xap/`
//    header) is not parsed, only the EXIF GPS pointer;
//  - PNG (`eXIf` chunk) and WebP (`EXIF` chunk) metadata is not checked.
export const JPEG_METADATA_PREFIX_LENGTH = 64 * 1024;

// The IFD0 tag whose presence means the file carries a GPS block
// (`GPSInfoIFDPointer`, EXIF 2.3 section 4.6.3).
const GPS_IFD_POINTER_TAG = 0x8825;

// `Exif\0\0`, the identifier every EXIF APP1 segment opens with.
const EXIF_IDENTIFIER = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00];

/**
 * SEC-43: whether a JPEG's leading bytes carry an EXIF GPS block, meaning the
 * IFD0 directory of an EXIF APP1 segment holds the GPS IFD pointer tag.
 *
 * Uploads go straight to the bucket through a presigned PUT, so the server
 * cannot strip metadata. The browser re-encodes every upload (`stripMetadata`
 * in the frontend upload helper), which drops EXIF entirely, so a file that
 * still carries a GPS block came from a client that skipped that step. The
 * serve route refuses it and `POST /uploads/confirm` names the cause.
 *
 * Walks the marker segments from the start-of-image marker up to the start of
 * scan, reading each APP1 segment that opens with the EXIF identifier. A
 * segment or directory that runs past the bytes read is ignored. `false` for
 * anything that is not a JPEG.
 */
export function jpegCarriesGpsLocation(bytes: Uint8Array): boolean {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) {
    return false;
  }
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      return false;
    }
    const marker = bytes[offset + 1]!;
    // Fill bytes: a run of 0xFF before the real marker.
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    // Start of scan or end of image: no metadata segment follows.
    if (marker === 0xda || marker === 0xd9) {
      return false;
    }
    const segmentLength = (bytes[offset + 2]! << 8) | bytes[offset + 3]!;
    if (segmentLength < 2) {
      return false;
    }
    const segmentStart = offset + 4;
    const segmentEnd = offset + 2 + segmentLength;
    if (
      marker === 0xe1 &&
      exifSegmentHasGpsPointer(
        bytes.subarray(segmentStart, Math.min(segmentEnd, bytes.length)),
      )
    ) {
      return true;
    }
    offset = segmentEnd;
  }
  return false;
}

/** Whether an APP1 segment's payload is EXIF whose IFD0 holds the GPS
 *  pointer tag. */
function exifSegmentHasGpsPointer(payload: Uint8Array): boolean {
  const hasExifIdentifier = EXIF_IDENTIFIER.every(
    (byte, index) => payload[index] === byte,
  );
  if (!hasExifIdentifier) {
    return false;
  }
  const tiff = payload.subarray(EXIF_IDENTIFIER.length);
  if (tiff.length < 8) {
    return false;
  }
  // Byte order: `II` little endian, `MM` big endian.
  const isLittleEndian = tiff[0] === 0x49 && tiff[1] === 0x49;
  const isBigEndian = tiff[0] === 0x4d && tiff[1] === 0x4d;
  if (!isLittleEndian && !isBigEndian) {
    return false;
  }
  const view = new DataView(tiff.buffer, tiff.byteOffset, tiff.byteLength);
  const ifdOffset = view.getUint32(4, isLittleEndian);
  if (ifdOffset + 2 > tiff.length) {
    return false;
  }
  const entryCount = view.getUint16(ifdOffset, isLittleEndian);
  for (let entry = 0; entry < entryCount; entry += 1) {
    const entryOffset = ifdOffset + 2 + entry * 12;
    if (entryOffset + 2 > tiff.length) {
      return false;
    }
    if (view.getUint16(entryOffset, isLittleEndian) === GPS_IFD_POINTER_TAG) {
      return true;
    }
  }
  return false;
}
