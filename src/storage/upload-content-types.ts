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
 * (PRD-226: a lease PDF, a flyer, a spreadsheet, a plain-text file). Video and
 * voice formats stay out of scope here; audio has exactly one home, a Studio
 * track (`studio_audio`, `STUDIO_AUDIO_UPLOAD_TYPES` at the end of this file). Same
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

/**
 * The one upload kind that takes either a document or an image: a listing's
 * menu (`listing-menu`), which an owner has as a PDF or as a photo of the
 * board. Every image type plus PDF only; spreadsheets and text files are no
 * use on a public page.
 */
export const LISTING_MENU_UPLOAD_TYPES: Readonly<
  Record<string, ImageUploadSpec>
> = {
  ...IMAGE_UPLOAD_TYPES,
  'application/pdf': { extension: '.pdf' },
};

/**
 * Studio v1: the audio a Studio track accepts, MP3 and AAC in an M4A, and
 * the extension each one's key ends in. The only audio this API stores.
 */
export interface AudioUploadSpec {
  extension: string;
}

export const STUDIO_AUDIO_UPLOAD_TYPES: Readonly<
  Record<string, AudioUploadSpec>
> = {
  'audio/mpeg': { extension: '.mp3' },
  'audio/mp4': { extension: '.m4a' },
};

export const ALLOWED_STUDIO_AUDIO_TYPES: readonly string[] = Object.keys(
  STUDIO_AUDIO_UPLOAD_TYPES,
);
