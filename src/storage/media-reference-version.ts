import { createHmac, randomBytes } from 'crypto';

// A public media reference (`public-media-reference.ts`) names a row and a
// place in it, so its URL stays the same when the photo stored there is
// replaced. Every URL built from a reference therefore carries `?v=<token>`,
// a short HMAC of the reference and the stored value: a new photo gives a new
// URL, so a cached copy of the old one is never shown in its place, and the
// serve route can let a browser or CDN keep a matching copy for a long time.
//
// An HMAC under a server secret: the token must say nothing about the key it
// was made from, uploader id included. The reference identity (surface, row
// id and slot) is part of the input, so one key stored on two surfaces (a
// listing cover reused on a persona, say) gets two unrelated tokens and the
// pair cannot be matched up by comparing URLs. Adding it changed every token
// once, which only made each reference URL new once.

/** Domain separation from every other use of the server secret. */
const MEDIA_REFERENCE_VERSION_PURPOSE = 'queerpulse:media-reference-version:v2';

/** Sits between the reference and the stored value in the HMAC input. Neither
 *  a reference nor a storage key can hold it, so no pair of inputs runs into
 *  another. */
const MEDIA_REFERENCE_VERSION_SEPARATOR = '\u0000';

/** The token's length in hex characters. */
export const MEDIA_REFERENCE_VERSION_HEX_LENGTH = 10;

let derivedVersionSecret: Buffer | null = null;

/**
 * The HMAC key, derived once per process from `JWT_ACCESS_SECRET` (required
 * at boot), as `messaging/matched-member-key.ts` derives its own. Rotating
 * that secret changes every token, which only makes each reference URL new
 * once. Under `NODE_ENV=test` with no secret a random per-process value keeps
 * every token stable for that process's life.
 */
function versionSecret(): Buffer {
  if (!derivedVersionSecret) {
    const serverSecret = process.env.JWT_ACCESS_SECRET;
    if (!serverSecret && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'JWT_ACCESS_SECRET must be set to version public media references',
      );
    }
    derivedVersionSecret = createHmac(
      'sha256',
      serverSecret || randomBytes(32).toString('hex'),
    )
      .update(MEDIA_REFERENCE_VERSION_PURPOSE)
      .digest();
  }
  return derivedVersionSecret;
}

/**
 * The version token of the photo whose stored value is `storedValue`, held at
 * `reference` (the canonical reference string, `formatPublicMediaReference`).
 * Every production caller passes `reference`. It is optional only so an older
 * call site keeps compiling; a token made without it matches no URL a read
 * writes, so such a request is served with the short cache lifetime.
 */
export function mediaReferenceVersion(
  storedValue: string,
  reference = '',
): string {
  return createHmac('sha256', versionSecret())
    .update(reference)
    .update(MEDIA_REFERENCE_VERSION_SEPARATOR)
    .update(storedValue)
    .digest('hex')
    .slice(0, MEDIA_REFERENCE_VERSION_HEX_LENGTH);
}
