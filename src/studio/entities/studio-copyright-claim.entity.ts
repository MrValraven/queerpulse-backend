import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioRelease } from './studio-release.entity';
import { StudioTrack } from './studio-track.entity';

export enum StudioCopyrightClaimStatus {
  Submitted = 'submitted',
  Accepted = 'accepted',
  Declined = 'declined',
  Countered = 'countered',
  Upheld = 'upheld',
  Rejected = 'rejected',
  Withdrawn = 'withdrawn',
}

export enum StudioClaimantRole {
  RightsHolder = 'rights_holder',
  Authorised = 'authorised',
}

/**
 * A member's copyright claim about one Studio track (Studio safety and
 * moderation, spec section 5). Separate from reports: a `copyright` report
 * on a track or release is refused and routed here.
 *
 * THE ROW NAMES NO ARTIST MEMBER. The claimant is stored, because a claim is
 * a notice a member files in their own name and staff judge standing from
 * it. Track ownership is checked when an owner sends a counter-notice and
 * written down nowhere, so the counter-notice keeps the persona apart
 * from the member who runs it, as a dispute does. `decided_by_id` names the staff
 * member who took the latest staff action, set null when that account goes.
 *
 * One live claim (`submitted`, `accepted`, `countered`) per track and
 * claimant (`UQ_studio_copyright_claims_live_track_claimant`). `track_id`
 * and `release_id` cascade on update, so a persona unlink that re-keys the
 * release and its tracks carries the claims along; deleting the claimant's
 * account cascades their claims away after the erasure restores what they
 * alone held. Every stamp holds milliseconds; `created_at` is the keyset
 * cursor of both claim lists. Migration `1834000100000-AddStudioSafety`.
 */
@Entity('studio_copyright_claims')
@Index(
  'UQ_studio_copyright_claims_live_track_claimant',
  ['trackId', 'claimantId'],
  {
    unique: true,
    where: `"status" IN ('submitted', 'accepted', 'countered')`,
  },
)
@Index('IDX_studio_copyright_claims_status_created_at', [
  'status',
  'createdAt',
  'id',
])
// The migration builds this one as ("claimant_id", "created_at" DESC,
// "id" DESC) for the claimant's newest-first list; TypeORM's `@Index`
// takes no column order, so a schema built by synchronize has it ascending.
@Index('IDX_studio_copyright_claims_claimant_created_at', [
  'claimantId',
  'createdAt',
  'id',
])
@Index('IDX_studio_copyright_claims_track', ['trackId'])
@Index('IDX_studio_copyright_claims_release', ['releaseId'])
@Check(
  'CHK_studio_copyright_claims_counter_pair',
  `("counter_note" IS NULL) = ("countered_at" IS NULL)`,
)
@Check(
  'CHK_studio_copyright_claims_reply_pair',
  `("claimant_reply" IS NULL) = ("replied_at" IS NULL)`,
)
@Check(
  'CHK_studio_copyright_claims_decided',
  `"status" NOT IN ('declined', 'upheld', 'rejected') OR "decided_at" IS NOT NULL`,
)
@Check(
  'CHK_studio_copyright_claims_accepted',
  `"status" NOT IN ('accepted', 'countered', 'upheld', 'rejected') OR "accepted_at" IS NOT NULL`,
)
@Check(
  'CHK_studio_copyright_claims_staff_note',
  `"status" NOT IN ('declined', 'upheld', 'rejected') OR "staff_note" IS NOT NULL`,
)
@Check(
  'CHK_studio_copyright_claims_original_link',
  `"original_link" IS NULL OR "original_link" ~* '^https?://'`,
)
export class StudioCopyrightClaim {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_copyright_claims',
  })
  id!: string;

  @Column({ type: 'uuid' })
  trackId!: string;

  @ManyToOne(() => StudioTrack, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_copyright_claims_track',
  })
  track?: StudioTrack;

  /** Denormalised for the staff queue's release card. */
  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_copyright_claims_release',
  })
  release?: StudioRelease;

  @Column({ type: 'uuid' })
  claimantId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'claimant_id',
    foreignKeyConstraintName: 'FK_studio_copyright_claims_claimant',
  })
  claimant?: User;

  @Column({
    type: 'enum',
    enum: StudioClaimantRole,
    enumName: 'studio_copyright_claims_claimant_role_enum',
  })
  claimantRole!: StudioClaimantRole;

  /** Title and creator of the original. */
  @Column({ type: 'varchar', length: 200 })
  originalWork!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  originalLink!: string | null;

  /** What the track copies and where. */
  @Column({ type: 'varchar', length: 2000 })
  details!: string;

  /** When the claimant ticked the good-faith statement. */
  @Column({ type: 'timestamptz', precision: 3 })
  goodFaithAt!: Date;

  @Column({
    type: 'enum',
    enum: StudioCopyrightClaimStatus,
    enumName: 'studio_copyright_claims_status_enum',
    default: StudioCopyrightClaimStatus.Submitted,
  })
  status!: StudioCopyrightClaimStatus;

  /** The artist's counter-notice. No member id is stored with it. */
  @Column({ type: 'varchar', length: 2000, nullable: true })
  counterNote!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  counteredAt!: Date | null;

  /** The claimant's one reply to the counter-notice. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  claimantReply!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  repliedAt!: Date | null;

  /** Shown to both sides on decline, uphold and reject. */
  @Column({ type: 'varchar', length: 1000, nullable: true })
  staffNote!: string | null;

  @Column({ type: 'uuid', nullable: true })
  decidedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'decided_by_id',
    foreignKeyConstraintName: 'FK_studio_copyright_claims_decided_by',
  })
  decidedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  acceptedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  /** The track title when the claim was filed. */
  @Column({ type: 'varchar', length: 120 })
  trackTitleAtFiling!: string;

  /** The artist persona's name when the claim was filed. */
  @Column({ type: 'varchar', length: 120 })
  artistNameAtFiling!: string;

  /**
   * Set by a persona unlink (`subprofile-unlink-rekey.ts`) on every claim
   * about its tracks. The claimant view and the data export then serve the
   * two names kept at filing with no track, release or persona reference,
   * so the claimant never sees the claim under the pseudonymous persona.
   * Staff and owners keep the cascaded ids.
   */
  @Column({ type: 'boolean', default: false })
  isSevered!: boolean;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
