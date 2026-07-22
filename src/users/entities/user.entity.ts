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
  id: string;

  @Column({ type: 'varchar', unique: true })
  googleId: string;

  @Column({ type: 'varchar', unique: true })
  email: string;

  @Column({
    type: 'enum',
    enum: UserStatus,
    enumName: 'users_status_enum',
    default: UserStatus.Active,
  })
  status: UserStatus;

  @Column({
    type: 'enum',
    enum: UserRole,
    enumName: 'users_role_enum',
    default: UserRole.Member,
  })
  role: UserRole;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'invited_by' })
  invitedBy: User | null;

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
  suspendedUntil: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  activatedAt: Date | null;

  /**
   * When the member self-attested to being 18+ (Terms §eligibility). Set once,
   * at signup, from the checkbox on the invite landing page. NULL means the
   * account predates the gate — see the backfill note in the migration.
   */
  @Column({ type: 'timestamptz', nullable: true })
  ageAttestedAt: Date | null;

  /** Terms revision the attestation was made against, e.g. "2.4". */
  @Column({ type: 'varchar', length: 32, nullable: true })
  termsVersion: string | null;

  // Per-user override for the monthly invite quota. NULL means "use the global
  // default" (app.inviteMonthlyQuota, itself defaulting to 1). Set directly in
  // the database to grant a member a higher (or lower) allowance.
  @Column({ type: 'integer', nullable: true })
  inviteMonthlyQuota: number | null;

  /**
   * Marks a non-human platform account (currently only the permanent
   * QueerPulse house account created by genesis). Orthogonal to `role`, which
   * stays `member`: this is an account *type*, not a permission level, so it
   * never rides through `RolesGuard` or `role === UserRole.X` checks. Its only
   * effect is to make the account editable by admins via the `admin/bots`
   * surface; everywhere else it remains an ordinary member.
   */
  @Column({ type: 'boolean', default: false })
  isSystem: boolean;

  @OneToOne(() => Profile, (profile) => profile.user)
  profile: Profile;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
