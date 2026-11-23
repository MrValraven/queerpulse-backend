import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import type { ConfigService } from '@nestjs/config';
import { createHash, createHmac } from 'node:crypto';
import { normalizeEmailIdentifier } from '../../ban-evasion/ban-evasion.hash';

/**
 * The email suppression list the delete-account UI promises: "Your email
 * address is added to a suppression list so we don't accidentally re-create
 * your account" (frontend `settings.ts` →
 * `deleteAccount.wh.delete.emailSuppressed`). `AuthService
 * .validateOrCreateGoogleUser` consults it before creating any new account.
 *
 * **No foreign key to `users` — deliberately.** Every other account-scoped
 * table cascades off the user row; this one has to be the exact opposite,
 * because its entire purpose is to still be there after the user row is gone.
 * A FK would delete the suppression entry in the same statement that erases the
 * account it is supposed to be protecting.
 *
 * **Stores a hash, not the address.** The list is permanent by design, so
 * storing plaintext would turn "erase my account" into "move my email address
 * into a forever-table" — the opposite of erasure, and a standing plaintext
 * registry of everyone who has ever left. A sha-256 of the normalized address
 * answers the only question we ever ask of it ("is *this* address suppressed?")
 * without retaining the address.
 *
 * SEC-14: new rows are keyed on a PEPPERED HMAC (`suppressionKeyForNewRow`).
 * Email addresses are a low-entropy, enumerable space, so the unsalted SHA-256
 * the table started with let anyone holding a read of it confirm that a given
 * person once had an account and erased it, by hashing the candidate address.
 * The HMAC needs the server-side pepper (`BAN_EVASION_PEPPER`, the same
 * write-once secret `ban-evasion.hash.ts` keys on, domain-separated so the two
 * tables never share a digest), which never sits in the database.
 *
 * Rows written before SEC-14 keep their SHA-256 key; there is no data
 * migration, since the plaintext needed to re-key them is gone by design.
 * Every lookup therefore asks for both keys (`suppressionLookupKeys`).
 *
 * With no pepper configured, new rows fall back to the SHA-256 key. A
 * suppression list that silently stops recording is the worse failure: the
 * erased member's address would become free to re-register. Rotating the
 * pepper orphans every HMAC row in the same way, so it stays write-once.
 */
@Entity('email_suppression')
export class EmailSuppression {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_email_suppression_email_hash', { unique: true })
  @Column({ type: 'varchar' })
  emailHash!: string;

  @Column({ type: 'varchar', default: 'account_deleted' })
  reason!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}

/**
 * The single place an email becomes a suppression-list key. Normalizes first
 * (lowercase + trim) so that `Foo@Example.com ` and `foo@example.com` are the
 * same entry — Google hands back inconsistent casing across providers, and a
 * suppression list that misses on case is not a suppression list.
 *
 * Note this does NOT strip gmail-style dots or `+tags`: those are
 * provider-specific rules, and silently suppressing `a+b@gmail.com` because
 * `a@gmail.com` left would block an address the member never asked us to block.
 *
 * This is the LEGACY key (unsalted SHA-256). New rows take
 * `suppressionKeyForNewRow`; this stays exported so lookups still match rows
 * written before SEC-14.
 */
export function hashSuppressedEmail(email: string): string {
  return createHash('sha256')
    .update(normalizeEmailIdentifier(email))
    .digest('hex');
}

/**
 * Domain label mixed into the pepper before it keys the suppression HMAC. The
 * ban-evasion store hashes the same normalized address under the same pepper,
 * so without this the two tables would hold identical digests and could be
 * joined row for row.
 */
const SUPPRESSION_HMAC_CONTEXT = 'qp:email-suppression:v1';

/**
 * The peppered key (SEC-14): HMAC-SHA256 of the normalized address under a
 * key derived from the pepper for this table alone. Null without a pepper.
 */
export function hmacSuppressedEmail(
  email: string,
  pepper: string | null | undefined,
): string | null {
  if (!pepper) return null;
  const tableKey = createHmac('sha256', pepper)
    .update(SUPPRESSION_HMAC_CONTEXT)
    .digest();
  return createHmac('sha256', tableKey)
    .update(normalizeEmailIdentifier(email))
    .digest('hex');
}

/**
 * The key a NEW suppression row is written under: the peppered HMAC, or the
 * legacy SHA-256 when no pepper is configured (see the entity doc for why a
 * weaker key beats no row).
 */
export function suppressionKeyForNewRow(
  email: string,
  pepper: string | null | undefined,
): string {
  return hmacSuppressedEmail(email, pepper) ?? hashSuppressedEmail(email);
}

/**
 * Every key an address may be stored under: the peppered HMAC (when a pepper
 * is configured) and the legacy SHA-256. Query with `In(...)` so rows written
 * on either side of SEC-14 both match.
 */
export function suppressionLookupKeys(
  email: string,
  pepper: string | null | undefined,
): string[] {
  const peppered = hmacSuppressedEmail(email, pepper);
  const legacy = hashSuppressedEmail(email);
  return peppered ? [peppered, legacy] : [legacy];
}

/**
 * The pepper the suppression keys use, read from config. `banEvasion.pepper`
 * is registered by `BanEvasionModule`'s `forFeature`; the raw env name is the
 * fallback so a reader in a module that loads before it still sees the value.
 */
export function suppressionPepper(
  config: Pick<ConfigService, 'get'>,
): string | undefined {
  return (
    config.get<string>('banEvasion.pepper') ??
    config.get<string>('BAN_EVASION_PEPPER')
  );
}
