import { createHmac } from 'crypto';
import { deriveEmailCodeKey } from './email-code-secret';

describe('deriveEmailCodeKey', () => {
  it('derives the key from EMAIL_CODE_SECRET when set', () => {
    const first = deriveEmailCodeKey(
      'email-code-secret',
      'jwt-secret',
      'production',
    );
    const second = deriveEmailCodeKey(
      'email-code-secret',
      'jwt-secret',
      'production',
    );
    const fromJwtAlone = deriveEmailCodeKey(
      undefined,
      'jwt-secret',
      'production',
    );

    expect(first).toHaveLength(32);
    expect(first.equals(second)).toBe(true);
    expect(first.equals(fromJwtAlone)).toBe(false);
  });

  it('falls back to JWT_ACCESS_SECRET', () => {
    const key = deriveEmailCodeKey(undefined, 'jwt-secret', 'production');
    const expected = createHmac('sha256', 'jwt-secret')
      .update('queerpulse:email-sign-in-code:v1')
      .digest();

    expect(key.equals(expected)).toBe(true);
    expect(deriveEmailCodeKey('', 'jwt-secret', 'production')).toEqual(
      expected,
    );
  });

  it('never returns the raw secret', () => {
    const secret = 'email-code-secret-that-is-32-chars';
    const key = deriveEmailCodeKey(secret, undefined, 'production');
    const expected = createHmac('sha256', secret)
      .update('queerpulse:email-sign-in-code:v1')
      .digest();

    expect(key.equals(expected)).toBe(true);
    expect(key.equals(Buffer.from(secret))).toBe(false);
  });

  it('throws outside test when both are missing', () => {
    expect(() =>
      deriveEmailCodeKey(undefined, undefined, 'production'),
    ).toThrow(
      'EMAIL_CODE_SECRET or JWT_ACCESS_SECRET must be set to issue sign-in codes',
    );
    expect(() => deriveEmailCodeKey(undefined, undefined, undefined)).toThrow(
      'EMAIL_CODE_SECRET or JWT_ACCESS_SECRET must be set to issue sign-in codes',
    );

    const testKey = deriveEmailCodeKey(undefined, undefined, 'test');
    expect(testKey).toHaveLength(32);
    // One random key per process, so every code minted in a test run verifies.
    expect(deriveEmailCodeKey(undefined, undefined, 'test')).toEqual(testKey);
  });
});
