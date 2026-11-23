import { createHash, createHmac, timingSafeEqual } from 'crypto';
import type { CookieOptions, Response } from 'express';
import type { AuthCookieOpts } from '../auth-cookies';
import { EMAIL_CODE_TRUSTED_REQUESTER_TTL_MS } from './email-code.constants';

/**
 * The trusted-requester cookie (SEC-11). A browser that has typed a correct
 * email code for an address gets this cookie, and its later code requests for
 * that address draw on a reserved daily allowance a stranger cannot spend.
 *
 * The value is `<expiry in epoch seconds>.<base64url HMAC-SHA256>`, the HMAC
 * taken over `v1|<expiry>|<sha256 hex of the normalized address>` with a key
 * of its own (`deriveEmailCodeTrustedRequesterKey`). The address and its
 * digest stay out of the cookie: checking it takes the address the request
 * names and recomputes the HMAC, so a cookie minted for one address proves
 * nothing for another.
 */

/** Name of the httpOnly trusted-requester cookie. */
export const EMAIL_CODE_TRUSTED_REQUESTER_COOKIE = 'email_code_trusted';

/** Scoped to the email code routes alone, the only ones that read it. */
export const EMAIL_CODE_TRUSTED_REQUESTER_COOKIE_PATH = '/auth/email-code';

const TOKEN_VERSION = 'v1';

/** Expiry seconds without a leading zero, a dot, then a 32-byte HMAC as
 *  unpadded base64url. Each token has exactly one accepted spelling. */
const WELL_FORMED_TOKEN = /^([1-9]\d{0,11})\.([A-Za-z0-9_-]{43})$/;

function addressDigest(normalizedEmail: string): string {
  return createHash('sha256').update(normalizedEmail).digest('hex');
}

function tokenMac(
  key: Buffer,
  expiresAtSeconds: number,
  normalizedEmail: string,
): Buffer {
  return createHmac('sha256', key)
    .update(
      `${TOKEN_VERSION}|${expiresAtSeconds}|${addressDigest(normalizedEmail)}`,
    )
    .digest();
}

/** A fresh cookie value for an address, valid for 90 days from `now`. */
export function mintTrustedRequesterToken(
  key: Buffer,
  normalizedEmail: string,
  now: Date,
): string {
  const expiresAtSeconds = Math.floor(
    (now.getTime() + EMAIL_CODE_TRUSTED_REQUESTER_TTL_MS) / 1000,
  );
  const mac = tokenMac(key, expiresAtSeconds, normalizedEmail);
  return `${expiresAtSeconds}.${mac.toString('base64url')}`;
}

/**
 * Whether a presented cookie value proves this browser verified a code for
 * this address and the proof has not expired. A missing, malformed, forged,
 * expired or other-address value answers false.
 */
export function isTrustedRequesterToken(
  key: Buffer,
  token: string | undefined,
  normalizedEmail: string,
  now: Date,
): boolean {
  if (typeof token !== 'string') return false;
  const match = WELL_FORMED_TOKEN.exec(token);
  if (!match) return false;
  const expiresAtSeconds = Number(match[1]);
  if (expiresAtSeconds * 1000 <= now.getTime()) return false;
  const presentedText = match[2] ?? '';
  const presented = Buffer.from(presentedText, 'base64url');
  // The last of 43 characters carries 2 spare bits, so several spellings
  // decode to the same bytes. Only the one the server mints is accepted.
  if (presented.toString('base64url') !== presentedText) return false;
  const expected = tokenMac(key, expiresAtSeconds, normalizedEmail);
  return (
    presented.length === expected.length && timingSafeEqual(presented, expected)
  );
}

function cookieOptions(opts: AuthCookieOpts): CookieOptions {
  return {
    httpOnly: true,
    secure: opts.secure,
    sameSite: 'lax',
    path: EMAIL_CODE_TRUSTED_REQUESTER_COOKIE_PATH,
    ...(opts.domain ? { domain: opts.domain } : {}),
  };
}

/**
 * Clears the cookie with the same path and domain it was set with, or the
 * browser keeps it. Sign-out calls this, so a shared device stops vouching
 * for the address once the member leaves.
 */
export function clearTrustedRequesterCookie(
  res: Response,
  opts: AuthCookieOpts,
): void {
  res.clearCookie(EMAIL_CODE_TRUSTED_REQUESTER_COOKIE, cookieOptions(opts));
}

/** Sets the cookie: httpOnly, SameSite=Lax, Secure in production, 90 days. */
export function setTrustedRequesterCookie(
  res: Response,
  value: string,
  opts: AuthCookieOpts,
): void {
  res.cookie(EMAIL_CODE_TRUSTED_REQUESTER_COOKIE, value, {
    ...cookieOptions(opts),
    maxAge: EMAIL_CODE_TRUSTED_REQUESTER_TTL_MS,
  });
}
