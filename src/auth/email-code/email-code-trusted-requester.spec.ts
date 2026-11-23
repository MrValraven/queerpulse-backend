import { createHash } from 'crypto';
import { Response } from 'express';
import {
  deriveEmailCodeKey,
  deriveEmailCodeTrustedRequesterKey,
} from './email-code-secret';
import {
  EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
  isTrustedRequesterToken,
  mintTrustedRequesterToken,
  setTrustedRequesterCookie,
} from './email-code-trusted-requester';

/**
 * SEC-11: the trusted-requester cookie proves a browser verified a code for
 * one address, carries an expiry and an HMAC only, and proves nothing for any
 * other address, after its expiry or once tampered with.
 */

const KEY = deriveEmailCodeTrustedRequesterKey(
  'email-code-secret-for-the-trusted-spec',
  undefined,
  'test',
);
const OTHER_KEY = deriveEmailCodeTrustedRequesterKey(
  'another-server-secret',
  undefined,
  'test',
);
const ADDRESS = 'sam@example.com';
const NOW = new Date('2026-11-23T12:00:00Z');
const NINETY_DAYS_MS = 90 * 24 * 60 * 60 * 1000;
const BASE64URL_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

interface ResponseMock {
  cookie: jest.Mock;
}

describe('trusted-requester token', () => {
  it('verifies for the address it was minted for until it expires', () => {
    const token = mintTrustedRequesterToken(KEY, ADDRESS, NOW);

    expect(isTrustedRequesterToken(KEY, token, ADDRESS, NOW)).toBe(true);
    const lastValidMoment = new Date(NOW.getTime() + NINETY_DAYS_MS - 1000);
    expect(isTrustedRequesterToken(KEY, token, ADDRESS, lastValidMoment)).toBe(
      true,
    );
    const expiry = new Date(NOW.getTime() + NINETY_DAYS_MS);
    expect(isTrustedRequesterToken(KEY, token, ADDRESS, expiry)).toBe(false);
  });

  it('the respellings it refuses decode to the same expiry and bytes as the minted token', () => {
    const token = mintTrustedRequesterToken(KEY, ADDRESS, NOW);
    const [expiry = '', mac = ''] = token.split('.');
    const lastIndex = BASE64URL_ALPHABET.indexOf(mac.slice(-1));
    const respelledMac = `${mac.slice(0, -1)}${BASE64URL_ALPHABET[lastIndex ^ 1]}`;

    expect(Number(`0${expiry}`)).toBe(Number(expiry));
    expect(respelledMac).not.toBe(mac);
    expect(Buffer.from(respelledMac, 'base64url')).toEqual(
      Buffer.from(mac, 'base64url'),
    );
  });

  it('holds neither the address nor its digest', () => {
    const token = mintTrustedRequesterToken(KEY, ADDRESS, NOW);
    const addressDigest = createHash('sha256').update(ADDRESS).digest('hex');

    expect(token).not.toContain('sam');
    expect(token).not.toContain('example');
    expect(token).not.toContain(addressDigest);
    expect(token).not.toContain(Buffer.from(ADDRESS).toString('base64url'));
    expect(token).toMatch(/^\d+\.[A-Za-z0-9_-]{43}$/);
  });

  it.each<[string, () => string | undefined]>([
    ['a missing cookie', () => undefined],
    ['an empty cookie', () => ''],
    ['the bare address', () => ADDRESS],
    [
      'a cookie minted for another address',
      () => mintTrustedRequesterToken(KEY, 'lee@example.com', NOW),
    ],
    [
      'a cookie signed with another key',
      () => mintTrustedRequesterToken(OTHER_KEY, ADDRESS, NOW),
    ],
    [
      'a cookie whose expiry was pushed out',
      () => {
        const [, mac] = mintTrustedRequesterToken(KEY, ADDRESS, NOW).split('.');
        return `99999999999.${mac}`;
      },
    ],
    [
      'a cookie with a flipped signature',
      () => {
        const [expiry, mac = ''] = mintTrustedRequesterToken(
          KEY,
          ADDRESS,
          NOW,
        ).split('.');
        const flipped = mac.startsWith('A')
          ? `B${mac.slice(1)}`
          : `A${mac.slice(1)}`;
        return `${expiry}.${flipped}`;
      },
    ],
    [
      'an expired cookie',
      () =>
        mintTrustedRequesterToken(
          KEY,
          ADDRESS,
          new Date(NOW.getTime() - NINETY_DAYS_MS - 1000),
        ),
    ],
    [
      'a valid cookie respelled with a leading zero on the expiry',
      () => `0${mintTrustedRequesterToken(KEY, ADDRESS, NOW)}`,
    ],
    [
      'a valid cookie respelled with a non-canonical last character',
      () => {
        const token = mintTrustedRequesterToken(KEY, ADDRESS, NOW);
        const lastIndex = BASE64URL_ALPHABET.indexOf(token.slice(-1));
        // Flips one of the 2 spare bits, which decodes to the same bytes.
        return `${token.slice(0, -1)}${BASE64URL_ALPHABET[lastIndex ^ 1]}`;
      },
    ],
  ])('treats %s as untrusted', (_label, tokenFor) => {
    expect(isTrustedRequesterToken(KEY, tokenFor(), ADDRESS, NOW)).toBe(false);
  });

  it('derives its key apart from the code key', () => {
    const codeSecret = 'email-code-secret-for-the-trusted-spec';
    const trustedKey = deriveEmailCodeTrustedRequesterKey(
      codeSecret,
      undefined,
      'production',
    );

    const codeKey = deriveEmailCodeKey(codeSecret, undefined, 'production');

    expect(trustedKey).toHaveLength(32);
    expect(trustedKey.equals(KEY)).toBe(true);
    expect(trustedKey.equals(codeKey)).toBe(false);
    expect(trustedKey.equals(Buffer.from(codeSecret))).toBe(false);
  });
});

describe('setTrustedRequesterCookie', () => {
  it('sets an httpOnly, SameSite=Lax cookie scoped to the email code routes for 90 days', () => {
    const mock: ResponseMock = { cookie: jest.fn() };

    setTrustedRequesterCookie(mock as unknown as Response, 'value-1', {
      secure: true,
      domain: 'queerpulse.example',
    });

    expect(mock.cookie).toHaveBeenCalledWith(
      EMAIL_CODE_TRUSTED_REQUESTER_COOKIE,
      'value-1',
      {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/auth/email-code',
        maxAge: NINETY_DAYS_MS,
        domain: 'queerpulse.example',
      },
    );
  });
});
