import { deriveEmailCodeKey } from '../auth/email-code/email-code-secret';
import {
  deriveStudioPurchaseReferenceKey,
  isStudioPurchaseReferenceValid,
  issueStudioPurchaseReference,
  signStudioPurchaseReference,
  STUDIO_PURCHASE_REFERENCE_TTL_SECONDS,
} from './studio-purchase-reference';

const KEY = deriveStudioPurchaseReferenceKey('test-secret', 'production');
const NOW = Date.parse('2026-10-28T12:00:00.000Z');
const BUYER_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_BUYER_ID = '22222222-2222-4222-8222-222222222222';
const SEVEN_DAYS_MILLISECONDS = STUDIO_PURCHASE_REFERENCE_TTL_SECONDS * 1000;

describe('studio purchase reference', () => {
  it('issues a code from the alphabet and a token valid for seven days', () => {
    const reference = issueStudioPurchaseReference(KEY, BUYER_ID, NOW);
    expect(reference.referenceCode).toMatch(/^[2-9A-HJKMNP-Z]{6}$/);
    expect(reference.expiresAt).toBe('2026-11-04T12:00:00.000Z');
    expect(
      isStudioPurchaseReferenceValid(
        KEY,
        BUYER_ID,
        reference.referenceCode,
        reference.referenceToken,
        NOW,
      ),
    ).toBe(true);
  });

  it('draws the code from the injected random source', () => {
    const reference = issueStudioPurchaseReference(KEY, BUYER_ID, NOW, () => 0);
    expect(reference.referenceCode).toBe('222222');
    expect(reference.referenceToken).toBe(
      signStudioPurchaseReference(
        KEY,
        BUYER_ID,
        '222222',
        Math.floor(NOW / 1000) + STUDIO_PURCHASE_REFERENCE_TTL_SECONDS,
      ),
    );
  });

  it('refuses the token for another member', () => {
    const { referenceCode, referenceToken } = issueStudioPurchaseReference(
      KEY,
      BUYER_ID,
      NOW,
    );
    expect(
      isStudioPurchaseReferenceValid(
        KEY,
        OTHER_BUYER_ID,
        referenceCode,
        referenceToken,
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses the token for another code', () => {
    const { referenceCode, referenceToken } = issueStudioPurchaseReference(
      KEY,
      BUYER_ID,
      NOW,
      () => 0,
    );
    expect(referenceCode).not.toBe('QP7K3G');
    expect(
      isStudioPurchaseReferenceValid(
        KEY,
        BUYER_ID,
        'QP7K3G',
        referenceToken,
        NOW,
      ),
    ).toBe(false);
  });

  it('refuses the token once it has expired', () => {
    const { referenceCode, referenceToken } = issueStudioPurchaseReference(
      KEY,
      BUYER_ID,
      NOW,
    );
    expect(
      [NOW + SEVEN_DAYS_MILLISECONDS, NOW + SEVEN_DAYS_MILLISECONDS - 1000].map(
        (checkedAt) =>
          isStudioPurchaseReferenceValid(
            KEY,
            BUYER_ID,
            referenceCode,
            referenceToken,
            checkedAt,
          ),
      ),
    ).toEqual([false, true]);
  });

  it('refuses a tampered token', () => {
    const { referenceCode, referenceToken } = issueStudioPurchaseReference(
      KEY,
      BUYER_ID,
      NOW,
    );
    const [expiryPart = '', macPart = ''] = referenceToken.split('.');
    const laterExpiry = Buffer.from(
      String(Number(Buffer.from(expiryPart, 'base64url').toString()) + 86400),
    ).toString('base64url');
    const flippedMac = (macPart.startsWith('A') ? 'B' : 'A') + macPart.slice(1);
    for (const token of [
      `${laterExpiry}.${macPart}`,
      `${expiryPart}.${flippedMac}`,
      `${expiryPart}.`,
      'garbage',
      `${referenceToken}.extra`,
      '',
    ]) {
      expect(
        isStudioPurchaseReferenceValid(
          KEY,
          BUYER_ID,
          referenceCode,
          token,
          NOW,
        ),
      ).toBe(false);
    }
  });

  it('signs with a key derived for this purpose alone', () => {
    const key = deriveStudioPurchaseReferenceKey('test-secret', 'production');
    expect(key).toHaveLength(32);
    expect(key.equals(Buffer.from('test-secret'))).toBe(false);
    expect(
      key.equals(deriveEmailCodeKey(undefined, 'test-secret', 'production')),
    ).toBe(false);
    expect(
      key.equals(deriveStudioPurchaseReferenceKey('test-secret', 'test')),
    ).toBe(true);
    expect(
      key.equals(deriveStudioPurchaseReferenceKey('other-secret', 'test')),
    ).toBe(false);
  });

  it('refuses to derive a key with no secret outside tests', () => {
    expect(() =>
      deriveStudioPurchaseReferenceKey(undefined, 'production'),
    ).toThrow();
    expect(deriveStudioPurchaseReferenceKey(undefined, 'test')).toHaveLength(
      32,
    );
  });
});
