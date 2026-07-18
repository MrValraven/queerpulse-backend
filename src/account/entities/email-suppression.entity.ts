import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

import { createHash } from 'node:crypto';

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
 * Honest limitation: email addresses are a low-entropy, enumerable space, so a
 * bare hash is not strong anonymization against an attacker who already holds a
 * candidate address and wants to confirm it. It is not meant to be — it removes
 * bulk-readable PII at rest, which is the risk that actually applies to a dump
 * of this table. A keyed HMAC with a secret from config would raise that bar;
 * it is not done here because the key would then be a new piece of
 * lose-it-and-the-list-is-dead state, which is a deployment decision rather
 * than a code one.
 */
@Entity('email_suppression')
export class EmailSuppression {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('UQ_email_suppression_email_hash', { unique: true })
  @Column({ type: 'varchar' })
  emailHash: string;

  @Column({ type: 'varchar', default: 'account_deleted' })
  reason: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
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
 */
export function hashSuppressedEmail(email: string): string {
  return createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
}
