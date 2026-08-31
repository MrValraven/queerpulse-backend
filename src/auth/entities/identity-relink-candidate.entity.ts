import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A Google identity that turned up at the door presenting the VERIFIED email
 * address of an account that is already keyed to a different Google subject.
 *
 * ## Why this table exists (PRD-06)
 *
 * Identity here is keyed on `users.google_id`. When a member's Google account
 * is re-created (a Workspace admin deletes and re-adds them, a consumer account
 * is deleted and the address later re-registered), Google issues a NEW subject
 * for the SAME verified address. `findByGoogleId` misses, and the sign-up path
 * then refuses the address with `email_in_use` because `users.email` is unique.
 * The member is locked out permanently: nothing in the product could re-point a
 * `users` row at a new subject, so the only remedy was a hand-written UPDATE
 * against production.
 *
 * ## Why the admin lever is driven by THIS row rather than a typed-in subject
 *
 * A Google subject id is an opaque numeric string that nobody can read off
 * their own account, so "let an admin type the new `google_id`" is both
 * unusable and the most dangerous endpoint on the platform: it would let one
 * admin point any member's account at any identity they control.
 *
 * Recording the candidate at the rejection instead makes the dangerous half
 * impossible. A row can only come into existence when someone completed a
 * Google OAuth round trip whose `email_verified` claim was true (enforced in
 * `GoogleStrategy.validate`) for the exact address the account already holds.
 * The admin lever can then only ever choose among identities that have ALREADY
 * proven control of the member's own address. An attacker who could produce a
 * candidate row for someone else's account already controls that person's
 * mailbox at Google, which is a loss that predates anything QueerPulse can do
 * about it.
 *
 * ## Shape notes
 *
 *  - `google_id` is `select: false`, matching `User.googleId`. It is the one
 *    piece of third-party identity PII on this row and there is no global
 *    serializer, so nothing loads it unless a query says `addSelect`. The admin
 *    surface never renders it in full (see `toRelinkCandidate`, which publishes
 *    a short tail so two candidates can be told apart and nothing more).
 *  - The unique `(user_id, google_id)` pair plus `attempt_count`/`last_seen_at`
 *    means a member hammering the sign-in button produces ONE row that counts
 *    up, not an unbounded insert stream from an unauthenticated endpoint.
 *  - `ON DELETE CASCADE` to `users`, unlike the actor-FK convention: this row
 *    is meaningless without the account it offers to re-key, and an erased
 *    account must not leave a standing offer to hand its identity to someone.
 *  - Rows are never deleted by the admin surface. A candidate is decided
 *    (`applied` / `dismissed`) or retired by a sibling being applied
 *    (`superseded`), so the trail of who else knocked survives the decision.
 */
export enum IdentityRelinkCandidateStatus {
  /** Seen, undecided. The only status the re-link lever will act on. */
  Pending = 'pending',
  /** An admin re-pointed the account at this identity. */
  Applied = 'applied',
  /** An admin looked and said no. Kept as a signal, never deleted. */
  Dismissed = 'dismissed',
  /** A sibling candidate for the same member was applied instead. */
  Superseded = 'superseded',
}

@Entity('identity_relink_candidates')
// The admin drawer reads "the pending candidates for this member, newest
// first"; the write path reads "(this member, this subject)" to bump an
// existing row. Both are covered by the indexes declared in
// `1796000000000-AddIdentityRelinkCandidates` (the unique pair index carries
// the explicit column list; the decorator API can't express the partial index
// on status, so the DDL is authoritative there).
@Index('IDX_identity_relink_candidates_user_id', ['userId'])
export class IdentityRelinkCandidate {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The EXISTING account whose verified email this identity presented. */
  @Column({ type: 'uuid' })
  userId!: string;

  /**
   * The Google subject that presented itself. `select: false` for the same
   * reason `User.googleId` is: it is auth-identity PII, and this repo hand-maps
   * every response, so leaving it unloaded is the last line of defence against
   * a future reader returning the row.
   */
  @Column({ type: 'varchar', select: false })
  googleId!: string;

  @Column({
    type: 'enum',
    enum: IdentityRelinkCandidateStatus,
    enumName: 'identity_relink_candidate_status_enum',
    default: IdentityRelinkCandidateStatus.Pending,
  })
  status!: IdentityRelinkCandidateStatus;

  /** How many times this subject has been turned away for this account. */
  @Column({ type: 'integer', default: 1 })
  attemptCount!: number;

  @Column({ type: 'timestamptz' })
  lastSeenAt!: Date;

  /** The admin who applied or dismissed this candidate. NULL while pending,
   *  and NULL again if that admin later erases their account. */
  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** The admin's own words for why they applied or dismissed it. Required at
   *  the DTO boundary for both decisions; NULL only while pending. */
  @Column({ type: 'text', nullable: true })
  decisionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
