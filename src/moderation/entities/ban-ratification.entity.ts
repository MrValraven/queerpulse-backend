import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Where a permanent ban sits between the moderator who asked for it and the
 * second moderator who confirms it.
 *
 * Article VIII of the constitution promises removal is "ratified by one
 * additional independent moderator". Nothing implemented that: one moderator
 * could permanently ban a member in a single `PATCH /mod/reports/:id`, or
 * across up to 100 reports at once through `PATCH /mod/reports/bulk`. This
 * table is the second signature.
 */
export enum BanRatificationStatus {
  /** Waiting for a second moderator. The member is suspended in the interim. */
  Pending = 'pending',
  /** A second, different moderator confirmed it. The ban is in force. */
  Ratified = 'ratified',
  /** A second moderator refused it. The interim suspension was lifted. */
  Declined = 'declined',
  /** Nobody confirmed inside the hold window. The ban lapsed. */
  Expired = 'expired',
  /** An overturned appeal (or a lifted suspension) removed the hold's basis. */
  Withdrawn = 'withdrawn',
}

/**
 * WHAT HAPPENS TO THE MEMBER WHILE A BAN IS PENDING: they are SUSPENDED, with
 * `users.suspended_until` set to this row's `expires_at`.
 *
 * That choice is deliberate, and the alternative (leave the account fully
 * active until a second moderator appears) was genuinely defensible. It was
 * rejected because a ban is reserved for conduct that makes the space unsafe
 * for other members, and leaving the account live for up to the whole hold
 * window means the cost of the ratification requirement is paid by the people
 * the ban exists to protect. Time-boxing the interim suspension to the hold's
 * own expiry is what makes it safe in the other direction: if no second
 * moderator ever appears, the suspension lapses by itself through
 * `JwtStrategy`'s existing lapsed-suspension path, with no cleanup job and no
 * moderator having to remember. `interim_action` records this on the row so the
 * audit trail states which choice was made rather than leaving a reader to
 * infer it.
 */
export const BAN_INTERIM_SUSPENSION = 'suspended_pending_ratification';

@Entity('ban_ratifications')
@Index('IDX_ban_ratifications_status_expires_at', ['status', 'expiresAt'])
// One pending hold per member at a time. A bulk ban across 100 reports naming
// the same member must create ONE hold rather than a hundred, and two
// moderators reaching for the ban button at the same instant must not open two
// races on the same account. Created by
// `1794921000000-AddBanRatification`; the decorator keeps entity metadata in
// step for any future `migration:generate` diff.
@Index('UQ_ban_ratifications_pending_target', ['targetUserId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
export class BanRatification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /**
   * The report the ban was decided from, when there was one. Nullable because
   * the direct admin path (`POST /admin/members/:id/restrict`) bans without a
   * report, exactly as `mod_audit_logs.report_id` is nullable for the same
   * reason.
   */
  @Index('IDX_ban_ratifications_report_id')
  @Column({ type: 'uuid', nullable: true })
  reportId!: string | null;

  /** The member the ban would remove. */
  @Index('IDX_ban_ratifications_target_user_id')
  @Column({ type: 'uuid' })
  targetUserId!: string;

  /**
   * Display-name snapshot at the moment of the request, following
   * `ModAuditLog.targetName`: the ratification queue must still be able to say
   * who this is about after the member is erased.
   */
  @Column({ type: 'varchar', nullable: true })
  targetName!: string | null;

  /**
   * The moderator who asked for the ban. NULLed on erasure like every other
   * actor column here, and the one id `decide()` refuses to accept as the
   * ratifier.
   */
  @Index('IDX_ban_ratifications_requested_by')
  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  /**
   * The first moderator's reason, in the exact member-facing words they wrote.
   * Carried here rather than re-read from the audit row because it is what the
   * ratifying moderator has to weigh, and what the member is told when the ban
   * finally lands.
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /** The `ReasonCode` the first moderator cited. */
  @Column({ type: 'varchar', nullable: true })
  reasonCode!: string | null;

  /** See {@link BAN_INTERIM_SUSPENSION}. */
  @Column({ type: 'varchar' })
  interimAction!: string;

  /**
   * When the hold lapses if nobody ratifies. Millisecond precision, matching
   * `reports.sla_due_at`, so the pending queue can page on it with the same
   * keyset machinery if it ever needs to.
   */
  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt!: Date;

  @Index('IDX_ban_ratifications_status')
  @Column({
    type: 'enum',
    enum: BanRatificationStatus,
    enumName: 'ban_ratifications_status_enum',
    default: BanRatificationStatus.Pending,
  })
  status!: BanRatificationStatus;

  /** The second moderator. Null until the hold is decided. */
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  /** The second moderator's own words, when they left any. */
  @Column({ type: 'text', nullable: true })
  decisionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
