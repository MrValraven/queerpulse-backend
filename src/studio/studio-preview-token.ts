import { randomBytes } from 'node:crypto';

/** Bytes of entropy behind a preview link, hex-encoded to 64 characters,
 *  the saved-list share token's recipe. */
const STUDIO_PREVIEW_TOKEN_BYTES = 32;

/** The shape a token is minted in, so a malformed `:token` is refused
 *  before it reaches Postgres. */
export const STUDIO_PREVIEW_TOKEN_PATTERN = /^[0-9a-f]{64}$/;

export function mintStudioPreviewToken(): string {
  return randomBytes(STUDIO_PREVIEW_TOKEN_BYTES).toString('hex');
}

export function isStudioPreviewToken(value: string): boolean {
  return STUDIO_PREVIEW_TOKEN_PATTERN.test(value);
}
