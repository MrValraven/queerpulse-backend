import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Where a PERMANENT community bar sits between the owner, co-owner or
 * moderator who asked for it and the second one who confirms it (PRD-25).
 *
 * Mirrors `BanRatification` (`src/moderation/entities/ban-ratification.entity.ts`),
 * the platform-level second signature TS-12 introduced, down to the status
 * vocabulary and the partial unique index on the pending row. The platform
 * judged a permanent removal too consequential for one person; a community bar
 * is the removal most members actually meet, and it kept no such check.
 */
export enum CommunityBanRatificationStatus {
  /**
   * Waiting for a second signatory. The member is already off the roster and
   * already barred, for
   * {@link COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days.
   */
  Pending = 'pending',
  /** A second, different signatory confirmed it. The bar is now permanent. */
  Ratified = 'ratified',
  /** A second signatory refused it. The 30-day bar stands unchanged. */
  Declined = 'declined',
  /** Nobody confirmed inside the hold window. The 30-day bar stands unchanged. */
  Expired = 'expired',
  /** The bar itself was lifted underneath the hold, so there is nothing left
   *  to make permanent. */
  Withdrawn = 'withdrawn',
}

/**
 * WHAT HAPPENS TO THE MEMBER WHILE A PERMANENT BAR IS PENDING: they are OFF
 * THE ROSTER and BARRED FOR 30 DAYS, from the first second.
 *
 * Nobody stays in a room they were just thrown out of while paperwork clears,
 * so the removal and the bar are both immediate and only the permanence waits.
 * That also means the hold needs no cleanup job to fail safe: the
 * `community_bans` row already carries a 30-day `expires_at`, so a hold nobody
 * ever decides leaves exactly the sanction the single signature on file was
 * worth. `interim_action` records the choice on the row, the way
 * `BAN_INTERIM_SUSPENSION` does at platform level, so the trail states it
 * rather than leaving a reader to infer it.
 */
export const COMMUNITY_BAN_INTERIM_ACTION = 'removed_and_barred_30_days';

@Entity('community_ban_ratifications')
// The per-community pending queue: `WHERE community_id = ? AND status = ?`
// ordered by `expires_at` ascending, which is both the list read and the lazy
// expiry sweep.
@Index('IDX_community_ban_ratifications_community_status_expires', [
  'communityId',
  'status',
  'expiresAt',
])
// One open hold per member per community. Two moderators reaching for the
// remove button at the same instant must not open two races on the same
// person, and re-removing someone who is already pending must join the hold on
// file rather than fork it. A plain unique index would also forbid a second
// hold months after the first was declined, which is wrong. Created by
// `1795850000000-AddCommunityBanRatification`; the decorator keeps entity
// metadata in step for any future `migration:generate` diff.
@Index(
  'UQ_community_ban_ratifications_pending',
  ['communityId', 'targetUserId'],
  { unique: true, where: `"status" = 'pending'` },
)
export class CommunityBanRatification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The community the bar is inside. Bars are community-scoped and say
   *  nothing about the member's standing anywhere else on QueerPulse. */
  @Column({ type: 'uuid' })
  communityId!: string;

  /** The member the permanent bar would keep out. */
  @Index('IDX_community_ban_ratifications_target_user_id')
  @Column({ type: 'uuid' })
  targetUserId!: string;

  /**
   * Display-name snapshot at the moment of the proposal, following
   * `BanRatification.targetName` and `ModAuditLog.targetName`: the queue must
   * still be able to say who this is about after the member erases their
   * account.
   */
  @Column({ type: 'varchar', nullable: true })
  targetName!: string | null;

  /**
   * The owner, co-owner or moderator who asked. NULLed on erasure like every
   * other actor column in this module, and the one id `decide()` refuses to
   * accept as the ratifier.
   */
  @Index('IDX_community_ban_ratifications_requested_by')
  @Column({ type: 'uuid', nullable: true })
  requestedBy!: string | null;

  /**
   * The proposer's reason, in the exact words they wrote on the removal. What
   * the second signatory has to weigh before putting their own name to keeping
   * someone out for good.
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  /**
   * The house rule the proposal cites, snapshotted the same way
   * `CommunityBan` snapshots it: `Community.rules` is a plain array and
   * `Community.rulesVersion` moves on every edit, so an index alone would
   * drift. All three are NULL together when nothing was cited.
   */
  @Column({ type: 'int', nullable: true })
  ruleIndex!: number | null;

  @Column({ type: 'int', nullable: true })
  ruleVersion!: number | null;

  @Column({ type: 'text', nullable: true })
  ruleText!: string | null;

  /** See {@link COMMUNITY_BAN_INTERIM_ACTION}. */
  @Column({ type: 'varchar' })
  interimAction!: string;

  /**
   * When the hold lapses if nobody signs. Millisecond precision, matching
   * `ban_ratifications.expires_at`, so the pending queue can page on it with
   * the same keyset machinery if it ever needs to.
   */
  @Column({ type: 'timestamptz', precision: 3 })
  expiresAt!: Date;

  @Column({
    type: 'enum',
    enum: CommunityBanRatificationStatus,
    enumName: 'community_ban_ratifications_status_enum',
    default: CommunityBanRatificationStatus.Pending,
  })
  status!: CommunityBanRatificationStatus;

  /** The second signatory. Null until the hold is decided. */
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  /** The second signatory's own words, when they left any. */
  @Column({ type: 'text', nullable: true })
  decisionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
