import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { hashEmailIdentifier } from '../../ban-evasion/ban-evasion.hash';
import {
  hashSuppressedEmail,
  hmacSuppressedEmail,
  suppressionKeyForNewRow,
  suppressionLookupKeys,
  suppressionPepper,
} from './email-suppression.entity';

const PEPPER = 'test-pepper';
const ADDRESS = 'Sam@Example.com ';
const legacyKey = createHash('sha256').update('sam@example.com').digest('hex');

describe('email suppression keys (SEC-14)', () => {
  it('keeps the legacy key byte for byte, so rows written before SEC-14 still match', () => {
    expect(hashSuppressedEmail(ADDRESS)).toBe(legacyKey);
  });

  it('writes new rows under a peppered HMAC that a bare SHA-256 of the address cannot reproduce', () => {
    const key = suppressionKeyForNewRow(ADDRESS, PEPPER);

    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(key).not.toBe(legacyKey);
    expect(key).toBe(hmacSuppressedEmail('sam@example.com', PEPPER));
  });

  it('normalizes case and surrounding whitespace before hashing', () => {
    expect(hmacSuppressedEmail(ADDRESS, PEPPER)).toBe(
      hmacSuppressedEmail('sam@example.com', PEPPER),
    );
  });

  it('changes the key when the pepper changes', () => {
    expect(hmacSuppressedEmail(ADDRESS, PEPPER)).not.toBe(
      hmacSuppressedEmail(ADDRESS, 'another-pepper'),
    );
  });

  it('keeps the suppression digest apart from the ban-evasion digest of the same address', () => {
    expect(hmacSuppressedEmail(ADDRESS, PEPPER)).not.toBe(
      hashEmailIdentifier(ADDRESS, PEPPER),
    );
  });

  it('falls back to the legacy key for new rows when no pepper is configured', () => {
    expect(hmacSuppressedEmail(ADDRESS, undefined)).toBeNull();
    expect(suppressionKeyForNewRow(ADDRESS, undefined)).toBe(legacyKey);
  });

  it('looks up both the peppered and the legacy key', () => {
    expect(suppressionLookupKeys(ADDRESS, PEPPER)).toEqual([
      hmacSuppressedEmail(ADDRESS, PEPPER),
      legacyKey,
    ]);
    expect(suppressionLookupKeys(ADDRESS, null)).toEqual([legacyKey]);
  });

  it('reads the pepper from the ban-evasion namespace, then from the raw env name', () => {
    const fromNamespace: Pick<ConfigService, 'get'> = {
      get: jest.fn((key: string) =>
        key === 'banEvasion.pepper' ? 'namespaced' : 'raw',
      ),
    };
    const fromEnvironment: Pick<ConfigService, 'get'> = {
      get: jest.fn((key: string) =>
        key === 'BAN_EVASION_PEPPER' ? 'raw' : undefined,
      ),
    };

    expect(suppressionPepper(fromNamespace)).toBe('namespaced');
    expect(suppressionPepper(fromEnvironment)).toBe('raw');
  });
});
