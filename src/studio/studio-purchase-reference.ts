import {
  createHmac,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';
import { generateStudioReferenceCode } from './studio-purchase-rules';

/**
 * Stateless purchase reference codes (contract 4.4). The buyer needs the code
 * while paying, before "I've paid" creates any row, so the server issues a
 * code with a signed token and stores the code only with the purchase. Nothing
 * about an issued code is stored or logged. The signing key is derived for
 * this purpose alone from the server secret the auth module signs sessions
 * with. Pure: `node:crypto` only.
 */

export const STUDIO_PURCHASE_REFERENCE_TTL_SECONDS = 7 * 24 * 60 * 60;
export const STUDIO_PURCHASE_REFERENCE_PURPOSE = 'studio-purchase-reference';

/** The random stand-in secret a test process uses, made once so every token
 *  minted in that process verifies against the same key. */
let testProcessSecret: string | null = null;

/**
 * HKDF-SHA256 key for signing purchase references. With no server secret the
 * call throws, except under `NODE_ENV=test` where a random per-process secret
 * stands in (the `deriveEmailCodeKey` rule).
 */
export function deriveStudioPurchaseReferenceKey(
  serverSecret: string | undefined,
  nodeEnv: string | undefined,
): Buffer {
  let secret = serverSecret;
  if (!secret) {
    if (nodeEnv !== 'test') {
      throw new Error(
        'A server secret must be set to issue Studio purchase reference codes',
      );
    }
    testProcessSecret ??= randomBytes(32).toString('hex');
    secret = testProcessSecret;
  }
  return Buffer.from(
    hkdfSync('sha256', secret, '', STUDIO_PURCHASE_REFERENCE_PURPOSE, 32),
  );
}

function referenceMac(
  key: Buffer,
  userId: string,
  referenceCode: string,
  expiresAtEpochSeconds: number,
): Buffer {
  return createHmac('sha256', key)
    .update(
      `${STUDIO_PURCHASE_REFERENCE_PURPOSE}|${userId}|${referenceCode}|${expiresAtEpochSeconds}`,
    )
    .digest();
}

/** `base64url(expiry epoch second) + '.' + base64url(HMAC-SHA256)`. */
export function signStudioPurchaseReference(
  key: Buffer,
  userId: string,
  referenceCode: string,
  expiresAtEpochSeconds: number,
): string {
  const expiryPart = Buffer.from(String(expiresAtEpochSeconds)).toString(
    'base64url',
  );
  const macPart = referenceMac(
    key,
    userId,
    referenceCode,
    expiresAtEpochSeconds,
  ).toString('base64url');
  return `${expiryPart}.${macPart}`;
}

export function issueStudioPurchaseReference(
  key: Buffer,
  userId: string,
  nowMilliseconds: number = Date.now(),
  randomIndex?: (max: number) => number,
): { referenceCode: string; referenceToken: string; expiresAt: string } {
  const referenceCode = generateStudioReferenceCode(randomIndex);
  const expiresAtEpochSeconds =
    Math.floor(nowMilliseconds / 1000) + STUDIO_PURCHASE_REFERENCE_TTL_SECONDS;
  return {
    referenceCode,
    referenceToken: signStudioPurchaseReference(
      key,
      userId,
      referenceCode,
      expiresAtEpochSeconds,
    ),
    expiresAt: new Date(expiresAtEpochSeconds * 1000).toISOString(),
  };
}

/** True when the token was signed for this member and code and has not
 *  expired. Any malformed part answers false and never throws. */
export function isStudioPurchaseReferenceValid(
  key: Buffer,
  userId: string,
  referenceCode: string,
  referenceToken: string,
  nowMilliseconds: number = Date.now(),
): boolean {
  try {
    const parts = referenceToken.split('.');
    if (parts.length !== 2) return false;
    const [expiryPart = '', macPart = ''] = parts;
    if (expiryPart === '' || macPart === '') return false;
    const expiryText = Buffer.from(expiryPart, 'base64url').toString();
    if (!/^[0-9]+$/.test(expiryText)) return false;
    const expiresAtEpochSeconds = Number(expiryText);
    if (!Number.isSafeInteger(expiresAtEpochSeconds)) return false;
    if (expiresAtEpochSeconds * 1000 <= nowMilliseconds) return false;
    const expectedMac = referenceMac(
      key,
      userId,
      referenceCode,
      expiresAtEpochSeconds,
    );
    const givenMac = Buffer.from(macPart, 'base64url');
    if (givenMac.length !== expectedMac.length) return false;
    return timingSafeEqual(givenMac, expectedMac);
  } catch {
    return false;
  }
}
