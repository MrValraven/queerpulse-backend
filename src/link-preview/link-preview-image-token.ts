import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/**
 * SEC-23: the signed address of a link preview's image.
 *
 * An unfurl used to hand the browser the page's `og:image` URL as-is, so every
 * reader's browser fetched it straight from the host the sender chose, and a
 * sender who controls that host learned each reader's IP, user agent and read
 * time. The card now carries an address on this API instead
 * (`GET /link-preview-images/<token>`), and the server fetches the image on the
 * reader's behalf.
 *
 * The token is `base64url(imageUrl) + '.' + base64url(HMAC-SHA256)`. Tokens
 * come only from the unfurler, which signs the image URL it parsed out of a
 * page it fetched. Whoever controls that page still picks the URL, so what
 * bounds the fetch is the SSRF-safe fetcher (`safeFetchImage`: public
 * addresses only, ports 80 and 443, image types, a byte cap and a timeout).
 * Nothing is stored, a token stays valid for as long as the server secret
 * does, and a restart or a second replica verifies it the same way. Both parts
 * must be canonical base64url, so each image URL has exactly one token.
 *
 * The signing key is derived for this purpose alone from the server secret the
 * auth module signs sessions with (the `studio-purchase-reference.ts` rule).
 */

const LINK_PREVIEW_IMAGE_TOKEN_PURPOSE = 'queerpulse:link-preview-image:v1';

/** The longest image URL the unfurler signs (the unfurl query's own cap). */
export const LINK_PREVIEW_IMAGE_URL_MAX_LENGTH = 2048;

/** base64url of a 32-byte HMAC-SHA256. */
const MAC_LENGTH = 43;

/** `<base64url url>.<base64url mac>`; the URL part is capped by the URL cap. */
const TOKEN_PATTERN = new RegExp(
  `^[A-Za-z0-9_-]{1,${Math.ceil((LINK_PREVIEW_IMAGE_URL_MAX_LENGTH * 4) / 3)}}\\.[A-Za-z0-9_-]{${MAC_LENGTH}}$`,
);

let derivedKey: Buffer | null = null;

/**
 * The HMAC key, derived once per process from `JWT_ACCESS_SECRET` (required at
 * boot). A process with no secret refuses to sign, except under
 * `NODE_ENV=test`, where a random per-process secret stands in.
 */
function signingKey(): Buffer {
  if (!derivedKey) {
    const serverSecret = process.env.JWT_ACCESS_SECRET;
    if (!serverSecret && process.env.NODE_ENV !== 'test') {
      throw new Error(
        'JWT_ACCESS_SECRET must be set to sign link preview image addresses',
      );
    }
    derivedKey = Buffer.from(
      hkdfSync(
        'sha256',
        serverSecret || randomBytes(32).toString('hex'),
        '',
        LINK_PREVIEW_IMAGE_TOKEN_PURPOSE,
        32,
      ),
    );
  }
  return derivedKey;
}

function imageUrlMac(imageUrl: string): Buffer {
  return createHmac('sha256', signingKey())
    .update(`${LINK_PREVIEW_IMAGE_TOKEN_PURPOSE}|${imageUrl}`)
    .digest();
}

/** Whether `imageUrl` is an http(s) URL short enough to sign. */
export function isSignableImageUrl(imageUrl: string): boolean {
  if (imageUrl.length > LINK_PREVIEW_IMAGE_URL_MAX_LENGTH) return false;
  try {
    const parsed = new URL(imageUrl);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/** The token for `imageUrl`. Callers check {@link isSignableImageUrl} first. */
export function signLinkPreviewImageToken(imageUrl: string): string {
  const urlPart = Buffer.from(imageUrl, 'utf8').toString('base64url');
  const macPart = imageUrlMac(imageUrl).toString('base64url');
  return `${urlPart}.${macPart}`;
}

/**
 * The image URL `token` was minted for, or null when the token is malformed,
 * its MAC does not match, or the URL inside it is one the unfurler would never
 * have signed.
 */
export function verifyLinkPreviewImageToken(token: string): string | null {
  if (!TOKEN_PATTERN.test(token)) return null;
  const [urlPart, macPart] = token.split('.');
  if (!urlPart || !macPart) return null;
  const urlBytes = Buffer.from(urlPart, 'base64url');
  const presented = Buffer.from(macPart, 'base64url');
  // Re-encoding must give back the exact text: stray trailing bits, or a
  // character the decoder skips, make a second spelling of one token.
  if (
    urlBytes.toString('base64url') !== urlPart ||
    presented.toString('base64url') !== macPart
  ) {
    return null;
  }
  const imageUrl = urlBytes.toString('utf8');
  if (Buffer.from(imageUrl, 'utf8').toString('base64url') !== urlPart) {
    return null;
  }
  if (!isSignableImageUrl(imageUrl)) return null;
  const expected = imageUrlMac(imageUrl);
  if (presented.length !== expected.length) return null;
  return timingSafeEqual(presented, expected) ? imageUrl : null;
}
