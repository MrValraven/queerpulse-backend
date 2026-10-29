import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';
import { StudioRelease } from './studio-release.entity';
import { StudioTrack } from './studio-track.entity';

export enum StudioPurchaseStatus {
  Pending = 'pending',
  Confirmed = 'confirmed',
  Declined = 'declined',
  Cancelled = 'cancelled',
  Expired = 'expired',
}

export enum StudioPurchaseDeclineReason {
  PaymentNotFound = 'payment_not_found',
  AmountDifferent = 'amount_different',
  Other = 'other',
}

export enum StudioPurchaseItemKind {
  Release = 'release',
  Track = 'track',
}

/**
 * The record a buyer creates with "I've paid". The buyer pays the artist
 * directly and QueerPulse holds no money; the artist confirms or declines
 * the claim. Nothing unlocks while the claim is pending. The row keeps
 * snapshots (`artist_name`, `item_title`, `item_kind`), so the record
 * outlives a deleted account, persona, release or track, and the release
 * and track keys set null on update as well, so a purchase never follows
 * the re-key of a persona unlink. The two descending indexes
 * (`IDX_studio_purchases_buyer_created_at` and
 * `IDX_studio_purchases_subprofile_decided_at`) live in the migration only.
 * Migration `1838000000000-AddStudioPurchases`.
 */
@Entity('studio_purchases')
@Check(
  'CHK_studio_purchases_item',
  `("item_kind" = 'release' AND "track_id" IS NULL) OR ("item_kind" = 'track' AND "release_id" IS NULL)`,
)
@Check('CHK_studio_purchases_amount', '"amount_cents" BETWEEN 0 AND 50000')
@Check(
  'CHK_studio_purchases_reference_code',
  `"reference_code" ~ '^[2-9A-HJKMNP-Z]{6}$'`,
)
@Check(
  'CHK_studio_purchases_decided',
  `("status" = 'pending') = ("decided_at" IS NULL)`,
)
@Check(
  'CHK_studio_purchases_decline',
  `("status" = 'declined') = ("decline_reason" IS NOT NULL)`,
)
@Check(
  'CHK_studio_purchases_decline_note',
  `"decline_note" IS NULL OR "status" = 'declined'`,
)
@Check(
  'CHK_studio_purchases_wall_identity',
  '"is_shown_as_persona" OR "shown_as_subprofile_id" IS NULL',
)
@Index('UQ_studio_purchases_reference_code', ['referenceCode'], {
  unique: true,
})
@Index('UQ_studio_purchases_pending_release', ['buyerUserId', 'releaseId'], {
  unique: true,
  where: `"status" = 'pending' AND "release_id" IS NOT NULL`,
})
@Index('UQ_studio_purchases_pending_track', ['buyerUserId', 'trackId'], {
  unique: true,
  where: `"status" = 'pending' AND "track_id" IS NOT NULL`,
})
@Index('IDX_studio_purchases_buyer_created_at', { synchronize: false })
@Index('IDX_studio_purchases_subprofile_status_created_at', [
  'subprofileId',
  'status',
  'createdAt',
  'id',
])
@Index('IDX_studio_purchases_subprofile_decided_at', { synchronize: false })
@Index('IDX_studio_purchases_release', ['releaseId'], {
  where: '"release_id" IS NOT NULL',
})
@Index('IDX_studio_purchases_track', ['trackId'], {
  where: '"track_id" IS NOT NULL',
})
@Index('IDX_studio_purchases_shown_as', ['shownAsSubprofileId'], {
  where: '"shown_as_subprofile_id" IS NOT NULL',
})
@Index('IDX_studio_purchases_decided_by', ['decidedByUserId'], {
  where: '"decided_by_user_id" IS NOT NULL',
})
@Index('IDX_studio_purchases_pending_created_at', ['createdAt'], {
  where: `"status" = 'pending'`,
})
export class StudioPurchase {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_purchases',
  })
  id!: string;

  /** Null once the buyer's account is erased. */
  @Column({ type: 'uuid', nullable: true })
  buyerUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'buyer_user_id',
    foreignKeyConstraintName: 'FK_studio_purchases_buyer',
  })
  buyer?: User | null;

  /** The artist persona paid; null after the persona is deleted or unlinked. */
  @Column({ type: 'uuid', nullable: true })
  subprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_purchases_subprofile',
  })
  subprofile?: Subprofile | null;

  /** Snapshot of the artist's display name at insert. */
  @Column({ type: 'varchar', length: 120 })
  artistName!: string;

  @Column({
    type: 'enum',
    enum: StudioPurchaseItemKind,
    enumName: 'studio_purchase_item_kind',
  })
  itemKind!: StudioPurchaseItemKind;

  /** Set at insert for a release purchase; null after a delete or re-key. */
  @Column({ type: 'uuid', nullable: true })
  releaseId!: string | null;

  @ManyToOne(() => StudioRelease, {
    onDelete: 'SET NULL',
    onUpdate: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_purchases_release',
  })
  release?: StudioRelease | null;

  /** Set at insert for a track purchase; null after a delete or re-key. */
  @Column({ type: 'uuid', nullable: true })
  trackId!: string | null;

  @ManyToOne(() => StudioTrack, {
    onDelete: 'SET NULL',
    onUpdate: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_purchases_track',
  })
  track?: StudioTrack | null;

  /** Snapshot of the release or track title at insert. */
  @Column({ type: 'varchar', length: 200 })
  itemTitle!: string;

  /** What the buyer says they paid, in euro cents. */
  @Column({ type: 'integer' })
  amountCents!: number;

  /** Six characters the buyer adds to the payment so the artist can match it. */
  @Column({ type: 'char', length: 6 })
  referenceCode!: string;

  @Column({ type: 'varchar', length: 60, nullable: true })
  payerName!: string | null;

  @Column({
    type: 'enum',
    enum: StudioPurchaseStatus,
    enumName: 'studio_purchase_status',
    default: StudioPurchaseStatus.Pending,
  })
  status!: StudioPurchaseStatus;

  @Column({
    type: 'enum',
    enum: StudioPurchaseDeclineReason,
    enumName: 'studio_purchase_decline_reason',
    nullable: true,
  })
  declineReason!: StudioPurchaseDeclineReason | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  declineNote!: string | null;

  @Column({ type: 'boolean', default: false })
  isOnWall!: boolean;

  /** The buyer chose to appear on the wall as a persona. A deleted chosen
   *  persona nulls `shownAsSubprofileId` and this flag stays true, so the
   *  entry leaves the wall until the buyer picks again. */
  @Column({ type: 'boolean', default: false })
  isShownAsPersona!: boolean;

  @Column({ type: 'uuid', nullable: true })
  shownAsSubprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'shown_as_subprofile_id',
    foreignKeyConstraintName: 'FK_studio_purchases_shown_as_subprofile',
  })
  shownAsSubprofile?: Subprofile | null;

  /** The persona member who confirmed or declined the claim. */
  @Column({ type: 'uuid', nullable: true })
  decidedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'decided_by_user_id',
    foreignKeyConstraintName: 'FK_studio_purchases_decided_by',
  })
  decidedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  createdAt!: Date;

  /** When the row left `pending`, by any route. */
  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  decidedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  updatedAt!: Date;
}
