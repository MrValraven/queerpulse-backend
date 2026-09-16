// Pure header builder for serving a `message-document` object through the
// backend (PRD-369). A document arrives from another member, so it is treated
// as hostile active content: it is always a download (`attachment`), it runs in
// an opaque sandbox if a browser renders it anyway, it is never sniffed, never
// cached, and never embeddable by another origin. No I/O here, so every header
// is unit-testable in isolation (see `document-download-headers.spec.ts`).
import { contentTypeForStorageKey } from './served-object';

// Content types a browser renders as a page when they reach it. They are served
// as opaque bytes instead, so even a browser that ignored `attachment` would
// offer a download rather than displaying text a stranger chose.
const RENDERABLE_TEXT_CONTENT_TYPES: ReadonlySet<string> = new Set([
  'text/plain',
  'text/csv',
]);

export const OPAQUE_DOWNLOAD_CONTENT_TYPE = 'application/octet-stream';

// Keeps the saved name readable while bounding the header size. Counted in code
// points, extension included.
export const MAX_DOWNLOAD_FILE_NAME_LENGTH = 180;

// Bidirectional marks, embeddings, overrides and isolates (U+200E, U+200F,
// U+202A to U+202E, U+2066 to U+2069). A right-to-left override lets a name
// display its real extension reversed, so these never reach a save dialog.
const BIDIRECTIONAL_CONTROL_CODE_POINTS: ReadonlySet<number> = new Set([
  0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067,
  0x2068, 0x2069,
]);

// Quotes and backslashes would end the quoted-string; slashes are path
// separators a download manager might honour.
const HEADER_AND_PATH_BREAKERS = /["\\/]/g;

// Code points removed outright: C0 and C1 control characters (which include CR
// and LF, the header-injection pair), lone surrogates (they make
// `encodeURIComponent` throw), and bidirectional controls. Checked by number so
// the source never has to spell these characters.
function isStrippedCodePoint(codePoint: number): boolean {
  const isControlCharacter =
    codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  const isLoneSurrogate = codePoint >= 0xd800 && codePoint <= 0xdfff;
  return (
    isControlCharacter ||
    isLoneSurrogate ||
    BIDIRECTIONAL_CONTROL_CODE_POINTS.has(codePoint)
  );
}

// `Array.from` walks code points, so a valid surrogate pair arrives as one
// astral character and only an unpaired half is seen as a surrogate.
function stripUnsafeCharacters(value: string): string {
  return Array.from(value)
    .filter((character) => !isStrippedCodePoint(character.codePointAt(0) ?? 0))
    .join('');
}

/** The final path segment of a storage key: the server-minted `<uuid>.<ext>`. */
export function storageKeyFileName(storageKey: string): string {
  const lastSlash = storageKey.lastIndexOf('/');
  return lastSlash === -1 ? storageKey : storageKey.slice(lastSlash + 1);
}

function storageKeyExtension(storageKey: string): string {
  const fileName = storageKeyFileName(storageKey);
  const lastDot = fileName.lastIndexOf('.');
  return lastDot === -1 ? '' : fileName.slice(lastDot).toLowerCase();
}

function truncateCodePoints(value: string, maxLength: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= maxLength
    ? value
    : codePoints.slice(0, maxLength).join('');
}

/**
 * The name a downloaded document is saved under. Starts from the member-supplied
 * display name (`attachment.fileName`), strips anything that could break the
 * header or a path, and always ends in the extension the server minted into the
 * key, so a name like "invoice.exe" saves as "invoice.exe.pdf" and opens as
 * what was actually validated. Falls back to the key's own `<uuid>.<ext>` when
 * there is no usable name.
 */
export function sanitizeDownloadFileName(
  originalFileName: string | null | undefined,
  storageKey: string,
): string {
  const fallbackFileName = storageKeyFileName(storageKey);
  if (typeof originalFileName !== 'string') {
    return fallbackFileName;
  }
  const extension = storageKeyExtension(storageKey);
  const cleaned = stripUnsafeCharacters(originalFileName)
    .normalize('NFC')
    .replace(HEADER_AND_PATH_BREAKERS, '_')
    .trim()
    .replace(/^\.+/, '')
    .trim();
  if (cleaned.length === 0) {
    return fallbackFileName;
  }
  const hasMintedExtension =
    extension.length > 0 && cleaned.toLowerCase().endsWith(extension);
  const baseName = hasMintedExtension
    ? cleaned.slice(0, cleaned.length - extension.length)
    : cleaned;
  const truncatedBaseName = truncateCodePoints(
    baseName,
    MAX_DOWNLOAD_FILE_NAME_LENGTH - Array.from(extension).length,
  ).trim();
  if (truncatedBaseName.length === 0) {
    return fallbackFileName;
  }
  return `${truncatedBaseName}${extension}`;
}

/**
 * The `filename="..."` value for clients that ignore `filename*`: printable
 * ASCII only. `%` is replaced as well because some browsers percent-decode the
 * plain parameter.
 */
export function asciiFallbackFileName(sanitizedFileName: string): string {
  return Array.from(sanitizedFileName)
    .map((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      const isPrintableAscii = codePoint >= 0x20 && codePoint <= 0x7e;
      return isPrintableAscii && character !== '%' ? character : '_';
    })
    .join('');
}

/** RFC 5987 / RFC 8187 `ext-value` encoding for `filename*=UTF-8''...`. */
export function encodeRfc5987Value(value: string): string {
  return encodeURIComponent(value).replace(
    /['()*]/g,
    (character) =>
      `%${character.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`,
  );
}

/** `attachment; filename="<ascii>"; filename*=UTF-8''<encoded>` (RFC 6266). */
export function attachmentContentDisposition(
  sanitizedFileName: string,
): string {
  return `attachment; filename="${asciiFallbackFileName(sanitizedFileName)}"; filename*=UTF-8''${encodeRfc5987Value(sanitizedFileName)}`;
}

/**
 * The content type a document is served with. The type is derived from the
 * key's server-minted extension (the object's stored `Content-Type` came from
 * the client's PUT and is not trusted). Text types, and anything unknown, go out
 * as opaque bytes.
 */
export function documentServedContentType(storageKey: string): string {
  const contentType = contentTypeForStorageKey(storageKey);
  if (!contentType || RENDERABLE_TEXT_CONTENT_TYPES.has(contentType)) {
    return OPAQUE_DOWNLOAD_CONTENT_TYPE;
  }
  return contentType;
}

export interface DocumentDownloadHeaderInput {
  storageKey: string;
  /** The member-supplied display name from `attachment.fileName`, if found. */
  originalFileName: string | null;
}

/** Every response header a streamed `message-document` download carries. */
export function buildDocumentDownloadHeaders(
  input: DocumentDownloadHeaderInput,
): Readonly<Record<string, string>> {
  const fileName = sanitizeDownloadFileName(
    input.originalFileName,
    input.storageKey,
  );
  return {
    'Content-Type': documentServedContentType(input.storageKey),
    'Content-Disposition': attachmentContentDisposition(fileName),
    // `sandbox` with no allow tokens gives a rendered document an opaque origin
    // with scripts, forms, popups and plugins disabled; `default-src 'none'`
    // stops it loading anything at all.
    'Content-Security-Policy': "sandbox; default-src 'none'",
    'X-Content-Type-Options': 'nosniff',
    // Blocks another origin from embedding the bytes as a subresource. A
    // top-level navigation (the SPA's `<a target="_blank">`) is not subject to
    // CORP, so the download link keeps working from the app's origin.
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Cache-Control': 'private, no-store',
  };
}
