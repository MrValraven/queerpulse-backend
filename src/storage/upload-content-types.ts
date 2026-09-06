// Single source of truth for accepted image content types. The DTOs validate
// the requested Content-Type against these keys; the controller derives the
// object-key extension from the same entry — no drift between the whitelist
// and the extension map. Byte caps are per-*kind* (see `upload-kinds.ts`),
// not per content type — a GIF avatar is capped the same as a PNG avatar.
export interface ImageUploadSpec {
  extension: string;
}

export const IMAGE_UPLOAD_TYPES: Readonly<Record<string, ImageUploadSpec>> = {
  'image/jpeg': { extension: '.jpg' },
  'image/png': { extension: '.png' },
  'image/webp': { extension: '.webp' },
  'image/gif': { extension: '.gif' },
};

export const ALLOWED_IMAGE_TYPES: readonly string[] =
  Object.keys(IMAGE_UPLOAD_TYPES);

/**
 * Accepted DOCUMENT content types for a message-composer document attachment
 * (PRD-226: a lease PDF, a flyer, a spreadsheet, a plain-text file — never a
 * video/audio/voice format, which stays deliberately out of scope). Same
 * whitelist-then-extension-from-the-same-entry contract as
 * `IMAGE_UPLOAD_TYPES`: the DTO validates the requested Content-Type against
 * these keys, the controller derives the object-key extension from the same
 * entry, so the whitelist and the extension map can never drift apart.
 *
 * `.xlsx` is the one modern spreadsheet format included; `.doc`/`.docx` word
 * processing documents were deliberately left out — the decided scope names
 * "PDFs and document formats (spreadsheets, plain text)", not word-processing
 * formats, and this table is the single place to add one later if the product
 * decision widens.
 */
export interface DocumentUploadSpec {
  extension: string;
}

export const DOCUMENT_UPLOAD_TYPES: Readonly<
  Record<string, DocumentUploadSpec>
> = {
  'application/pdf': { extension: '.pdf' },
  'text/plain': { extension: '.txt' },
  'text/csv': { extension: '.csv' },
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': {
    extension: '.xlsx',
  },
};

export const ALLOWED_DOCUMENT_TYPES: readonly string[] = Object.keys(
  DOCUMENT_UPLOAD_TYPES,
);
