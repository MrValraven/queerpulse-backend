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
