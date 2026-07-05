// Single source of truth for accepted image uploads. The DTO validates the
// requested Content-Type against these keys; the controller derives the
// object-key extension and the presigned-POST size cap from the same entry —
// no drift between the whitelist and the extension map.
export interface ImageUploadSpec {
  extension: string;
  maxBytes: number;
}

const MB = 1024 * 1024;

export const IMAGE_UPLOAD_TYPES: Readonly<Record<string, ImageUploadSpec>> = {
  'image/jpeg': { extension: '.jpg', maxBytes: 5 * MB },
  'image/png': { extension: '.png', maxBytes: 5 * MB },
  'image/webp': { extension: '.webp', maxBytes: 5 * MB },
  'image/gif': { extension: '.gif', maxBytes: 8 * MB },
};

export const ALLOWED_IMAGE_TYPES: readonly string[] =
  Object.keys(IMAGE_UPLOAD_TYPES);
