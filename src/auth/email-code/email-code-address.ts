import { isEmail } from 'class-validator';

/** The longest address SMTP can carry (RFC 5321 path limit). */
const MAX_EMAIL_ADDRESS_LENGTH = 254;
const MIN_EMAIL_ADDRESS_LENGTH = 3;

/**
 * The one normalization every email code path applies before it counts,
 * stores, sends or looks up an address. Trim and lowercase only: dots and
 * plus tags stay as typed, so the address we send to is the one the person
 * entered.
 */
export function normalizeEmailAddress(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Whether a normalized address is worth sending a code to. */
export function isDeliverableEmailAddress(normalized: string): boolean {
  return (
    normalized.length >= MIN_EMAIL_ADDRESS_LENGTH &&
    normalized.length <= MAX_EMAIL_ADDRESS_LENGTH &&
    isEmail(normalized)
  );
}
