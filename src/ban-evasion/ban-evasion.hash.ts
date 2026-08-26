import { createHmac } from 'crypto';

/**
 * One-way comparison tokens for the ban-evasion signal store.
 *
 * Every value that reaches the `removed_account_signals` table goes through
 * here first. Nothing raw is ever written: no email address, no OAuth subject
 * id, no name. The digest is HMAC-SHA256 under a pepper held only in the
 * server's environment, so the stored value cannot be walked back to the
 * address it came from even by someone holding the whole table.
 *
 * Normalization has to be identical on both sides of a comparison (the removed
 * account at ban time, the applicant at review time), so it lives in one place.
 */

/** Lowercase and trim, the shape `join_requests.email` is already stored in. */
export function normalizeEmailIdentifier(value: string): string {
  return value.trim().toLowerCase();
}

/**
 * Fold a stated name to something two spellings of the same name agree on:
 * trimmed, lowercased, internal whitespace collapsed, diacritics removed. "José
 * Da  Silva" and "jose da silva" produce the same token.
 */
export function normalizeStatedName(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

/**
 * HMAC-SHA256 hex digest of an already-normalized value.
 *
 * Returns null when there is no pepper configured or nothing to hash, so every
 * caller gets the same fail-safe: a missing signal rather than a weak one.
 */
export function hashWithPepper(
  normalizedValue: string | null | undefined,
  pepper: string | undefined | null,
): string | null {
  if (!pepper) return null;
  if (!normalizedValue) return null;
  return createHmac('sha256', pepper).update(normalizedValue).digest('hex');
}

/** Convenience wrapper: normalize an email address, then hash it. */
export function hashEmailIdentifier(
  email: string | null | undefined,
  pepper: string | undefined | null,
): string | null {
  if (!email) return null;
  return hashWithPepper(normalizeEmailIdentifier(email), pepper);
}

/** Convenience wrapper: normalize a stated name, then hash it. */
export function hashStatedName(
  name: string | null | undefined,
  pepper: string | undefined | null,
): string | null {
  if (!name) return null;
  return hashWithPepper(normalizeStatedName(name), pepper);
}

/**
 * Hash an OAuth subject identifier. Opaque provider-issued strings are compared
 * byte for byte, so only whitespace is trimmed.
 */
export function hashOauthSubject(
  subject: string | null | undefined,
  pepper: string | undefined | null,
): string | null {
  if (!subject) return null;
  return hashWithPepper(subject.trim(), pepper);
}
