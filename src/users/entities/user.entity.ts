import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Profile } from './profile.entity';

/**
 * There is no `Pending` state. A person who is not a member has NO `users` row
 * at all — they exist only as a `join_requests` row until an admin approves
 * them and they redeem the resulting invite through Google sign-up, which
 * creates them `Active` in one step. See `RemovePendingStatus1782800740000`.
 */
export enum UserStatus {
  Active = 'active',
  Suspended = 'suspended',
  /**
   * Member-initiated, reversible hiding. Set by `AccountService.deactivate`
   * (explicit "pause my account") and by `AccountService.requestDeletion`
   * (the 30-day erasure grace period, during which the UI promises the member
   * is already hidden).
   *
   * The whole point of it being a `UserStatus` rather than only a row in
   * `account_deactivation` is that the codebase is already full of
   * `status = UserStatus.Active` predicates — directory search, feed, member
   * refs, connection/cohost/invite targets, `ActiveMemberGuard`, the chat
   * handshake. Anything that is not `Active` is already excluded by all of
   * them, so hiding rides on machinery that exists instead of needing a new
   * filter in every query.
   *
   * NEVER restore a member to `Active` by hardcoding it — restore the
   * `previous_status` recorded when they were deactivated, or a suspended
   * member could launder away their suspension by deactivating and signing
   * back in. See `AccountDeactivation.previousStatus`.
   */
  Deactivated = 'deactivated',
}

export enum UserRole {
  Member = 'member',
  Moderator = 'moderator',
  Admin = 'admin',
}

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // `googleId` and `email` are the only PII on the auth row, and they are
  // `select: false` as column-level defense-in-depth: there is no global
  // serializer here — every endpoint hand-maps entities to DTOs — so the ONLY
  // thing standing between a future `return usersService.findById()` and a
  // leaked auth row is that these columns are not loaded unless a query opts
  // back in. A reader that legitimately needs them says so explicitly, either
  // with `addSelect('user.email')` on a QueryBuilder or `select: { email: true }`
  // in find options (both re-include a `select: false` column). Grep for those
  // to enumerate every place that reads real PII. `googleId` currently has NO
  // value-reader in app code (only WHERE clauses, which are unaffected).
  @Column({ type: 'varchar', unique: true, select: false })
  googleId!: string;

  @Column({ type: 'varchar', unique: true, select: false })
  email!: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'users_status_enum',
    default: UserStatus.Active,
  })
  status!: UserStatus;

  @Column({
    type: 'enum',
    enum: UserRole,
    enumName: 'users_role_enum',
    default: UserRole.Member,
  })
  role!: UserRole;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by' })
  invitedBy!: User | null;

  /**
   * When a moderation suspension lapses. Only meaningful while
   * `status = Suspended`, where it is the *only* thing distinguishing the two
   * enforcement actions: `suspend` sets it from the action's `duration`,
   * `ban` leaves it NULL meaning permanent.
   *
   * Expiry is lazy with write-through in `JwtStrategy.validate` rather than a
   * scheduled sweep — the suspended member's own next request restores them and
   * writes `status`/`suspended_until` back, so the directory, feed and search
   * (which read `status` directly, never through the strategy) see them again
   * too. A member who never returns keeps a stale row and stays hidden; that
   * self-corrects the moment they come back.
   *
   * Never set this without also setting `status` — a `suspended_until` on an
   * `active` row enforces nothing, and a `Suspended` row whose expiry was
   * meant to be set but wasn't is an accidental permanent ban.
   */
  @Column({ type: 'timestamptz', nullable: true })
  suspendedUntil!: Date | null;

  /**
   * A scoped moderation restriction — the `restrict` action's real effect (see
   * `AccountEnforcementService.enforceAgainstUser`). Deliberately orthogonal to
   * `status`/`suspendedUntil`: a restricted member stays `Active` and keeps
   * ordinary read/browse access and most writes; only the handlers gated by
   * `NotRestrictedGuard` (forum thread + reply creation; starting a
   * conversation, a group, or a message request; sending a message) reject
   * them while `restricted` is true. Always paired with a `restrictedUntil`
   * expiry — there
   * is no permanent/indefinite restriction, so it always self-lifts and never
   * needs a moderator "lift" action.
   */
  @Column({ type: 'boolean', default: false })
  restricted!: boolean;

  /**
   * When the current restriction lapses. Lazy expiry with write-through in
   * `JwtStrategy.liftExpiredRestriction`, mirroring `suspendedUntil`'s pattern:
   * the member's own next request clears it. Meaningless while
   * `restricted = false` (always `null` then).
   */
  @Column({ type: 'timestamptz', nullable: true })
  restrictedUntil!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt!: Date | null;

  /**
   * When the member self-attested to being 18+ (Terms §eligibility). Set once,
   * at signup, from the checkbox on the invite landing page. NULL means the
   * account predates the gate — see the backfill note in the migration.
   */
  @Column({ type: 'timestamptz', nullable: true })
  ageAttestedAt!: Date | null;

  /** Terms revision the attestation was made against, e.g. "2.4". */
  @Column({ type: 'varchar', length: 32, nullable: true })
  termsVersion!: string | null;

  /**
   * When the member told us they are NOT 18 yet — the onboarding wizard's
   * "I'm not 18" branch, recorded by `POST /auth/under-18-disclosure`
   * (`UnderAgeDisclosureService`). The counterpart to `ageAttestedAt`: one is
   * an affirmative "I am 18+", this is the retraction of it.
   *
   * Stamped ONCE and never cleared. Nothing on the platform lifts it, and it is
   * deliberately not a self-expiring "until their birthday" clock: we have no
   * date of birth, only a declaration. Reaching 18 is handled by a human
   * through the contact link the notice shows, never by a timer.
   *
   * Always written together with `status = Suspended` and `suspendedUntil =
   * null` (permanent, the same shape a ban takes — see `suspendedUntil`), so
   * the account is out of an adults-only space rather than merely annotated.
   * NULL for everyone who has made no such declaration; never backfilled (see
   * `AddUnderAgeDisclosure1793700000000`).
   */
  @Column({ type: 'timestamptz', nullable: true })
  underAgeDisclosedAt!: Date | null;

  /**
   * When the member finished the one-time post-signup onboarding wizard. NULL
   * means they haven't yet; a timestamp means done and is stamped once (never
   * overwritten) by `UsersService.markOnboarded`. Surfaced as
   * `AuthUser.onboardedAt` so the frontend gate can keep an already-onboarded
   * member out of the wizard. Backfilled to `created_at` for pre-existing rows
   * — see `AddOnboardedAt1785003000000`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  onboardedAt!: Date | null;

  /**
   * When the member agreed to the community guidelines. Stamped once, alongside
   * `onboardedAt`, when they finish the onboarding wizard (the guidelines
   * checkbox on the welcome step). NULL means no explicit agreement is on
   * record — either they haven't onboarded yet, or their account predates this
   * consent being captured (deliberately NOT backfilled: agreeing is a specific
   * act, so a manufactured timestamp would be a lie — see
   * `AddGuidelinesAgreement1785800100000`). Recorded by
   * `UsersService.markOnboarded`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  guidelinesAcceptedAt!: Date | null;

  /** The community-guidelines revision the agreement was made against, e.g.
   *  "1.0". NULL whenever `guidelinesAcceptedAt` is NULL. */
  @Column({ type: 'varchar', length: 32, nullable: true })
  guidelinesVersion!: string | null;

  /**
   * When the member accepted the LGBTQ+ affirming housing pledge — the mandatory
   * universal baseline every housing write/contact action gates on (see
   * `AffirmingPledgeService`). Stamped ONCE, the first time they accept, and
   * never overwritten. NULL means no acceptance is on record: the member can
   * still browse housing freely, but any gated action returns a typed
   * `AFFIRMING_PLEDGE_REQUIRED` 403 until they accept.
   *
   * Deliberately NOT backfilled (like `guidelinesAcceptedAt`, unlike
   * `onboardedAt`): accepting the pledge is a specific, legally-meaningful act,
   * so a manufactured timestamp would be a lie. Existing members are prompted to
   * accept the first time they post or reach out — browsing is never blocked.
   * See `AddAffirmingPledge1787900500000`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  affirmingPledgeAcceptedAt!: Date | null;

  // Per-user override for the monthly invite quota. NULL means "use the global
  // default" (app.inviteMonthlyQuota, itself defaulting to 5). Set directly in
  // the database to grant a member a higher (or lower) allowance.
  @Column({ type: 'integer', nullable: true })
  inviteMonthlyQuota!: number | null;

  /**
   * Marks a non-human platform account (currently only the permanent
   * QueerPulse house account created by genesis). Orthogonal to `role`, which
   * stays `member`: this is an account *type*, not a permission level, so it
   * never rides through `RolesGuard` or `role === UserRole.X` checks. Its only
   * effect is to make the account editable by admins via the `admin/bots`
   * surface; everywhere else it remains an ordinary member.
   */
  @Column({ type: 'boolean', default: false })
  isSystem!: boolean;

  @OneToOne(() => Profile, (profile) => profile.user)
  profile!: Profile;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
