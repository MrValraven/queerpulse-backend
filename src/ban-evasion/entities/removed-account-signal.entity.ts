import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Which door was closed on the account this row remembers. */
export enum RemovalKind {
  PlatformBan = 'platform_ban',
  CommunityBan = 'community_ban',
}

/**
 * The correlation material left behind by a removed account, so a human
 * reviewer can be told "this application looks like it may be someone who was
 * removed" and go and check.
 *
 * WHAT THIS IS NOT. It is not a block list: nothing reads this table to deny
 * anyone access. It is not behavioural tracking: it records no IP address, no
 * device fingerprint, no page view, no action anyone took on the platform. The
 * only thing a row says is "an account that was removed on this date carried
 * these hashed identifiers and came in through this member".
 *
 * WHY IT SURVIVES ACCOUNT ERASURE. The whole point of ban-evasion detection is
 * that the account is gone, so a row hanging off `users` with `ON DELETE
 * CASCADE` would delete itself exactly when it becomes useful. Every column
 * here is therefore either a salted hash or a nullable reference:
 *
 *  - The hashes are HMAC-SHA256 of a normalized sign-in identifier under a
 *    server-side pepper (`BAN_EVASION_PEPPER`) that never leaves the backend
 *    and is never stored in the database. Without the pepper the digest cannot
 *    be reversed or dictionary-attacked back to the address it came from, and
 *    it identifies no living person on its own. It answers exactly one closed
 *    question, "is the identifier in front of me the same one as this", which
 *    is why retaining it stays compatible with erasing the account: the
 *    personal data (the address, the name, the profile) is deleted, and what
 *    remains is a one-way comparison token.
 *  - `removedUserId`, `inviterUserId` and `referenceUserId` are `ON DELETE SET
 *    NULL`. When one of those people erases their account the link goes and the
 *    row stays, so erasure genuinely removes the identifiable part while the
 *    hashed comparison material still does its job.
 *
 * Paired migration `1794611000000-CreateRemovedAccountSignals`.
 */
@Entity('removed_account_signals')
export class RemovedAccountSignal {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The removed account, while it still exists. NULL once that account has been
   * erased, which is the ordinary end state for a row that matters: the hashes
   * below carry on working without it.
   */
  @Index('IDX_removed_account_signals_removed_user_id')
  @Column({ type: 'uuid', nullable: true })
  removedUserId!: string | null;

  @Column({
    type: 'enum',
    enum: RemovalKind,
    enumName: 'removed_account_signals_kind_enum',
  })
  removalKind!: RemovalKind;

  /**
   * Set for a community ban, NULL for a platform ban. `ON DELETE SET NULL`: a
   * community being deleted does not unmake the removal that happened.
   */
  @Index('IDX_removed_account_signals_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId!: string | null;

  /** When the removal landed, as the reviewer needs to see it. */
  @Column({ type: 'timestamptz' })
  removedAt!: Date;

  /**
   * HMAC of the account's sign-in email address, lowercased and trimmed. NULL
   * when no pepper is configured (the module refuses to write a weak digest) or
   * when the account row had already gone before this ran.
   */
  @Index('IDX_removed_account_signals_sign_in_email_hash')
  @Column({ type: 'varchar', length: 64, nullable: true })
  signInEmailHash!: string | null;

  /**
   * HMAC of the OAuth subject identifier the provider issues for this person
   * (Google's `sub`). Stable across an email change at the provider, which is
   * the case a bare email hash misses.
   */
  @Index('IDX_removed_account_signals_oauth_subject_hash')
  @Column({ type: 'varchar', length: 64, nullable: true })
  oauthSubjectHash!: string | null;

  /**
   * HMAC of the address on the join request or invite that brought this account
   * in, which is often a different address from the one they ended up signing
   * in with.
   */
  @Index('IDX_removed_account_signals_intake_email_hash')
  @Column({ type: 'varchar', length: 64, nullable: true })
  intakeEmailHash!: string | null;

  /**
   * HMAC of the name stated on the join request, normalized (lowercased,
   * whitespace collapsed, diacritics folded). The weakest of the four hashes by
   * a distance: plenty of unrelated people share a name, so on its own it never
   * reaches a high tier.
   */
  @Index('IDX_removed_account_signals_stated_name_hash')
  @Column({ type: 'varchar', length: 64, nullable: true })
  statedNameHash!: string | null;

  /** The member whose invite this account came in on. `ON DELETE SET NULL`. */
  @Index('IDX_removed_account_signals_inviter_user_id')
  @Column({ type: 'uuid', nullable: true })
  inviterUserId!: string | null;

  /**
   * The member named as a reference on this account's join request, resolved at
   * submit time (`PlatformJoinRequest.referenceUserId`). `ON DELETE SET NULL`.
   */
  @Index('IDX_removed_account_signals_reference_user_id')
  @Column({ type: 'uuid', nullable: true })
  referenceUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
