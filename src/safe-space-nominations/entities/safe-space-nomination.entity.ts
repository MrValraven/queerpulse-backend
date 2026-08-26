import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of a member-submitted safe-space nomination. Stored as a plain
 * varchar (not a PG enum) so a future review outcome can be added without a
 * schema migration — the same extensible-status precedent used for staff-role
 * codes. New rows always start `pending`; a moderator later moves them on.
 *
 * The states track the published six-step promise one for one:
 *  - `pending`      submitted, nobody has looked yet. The 48-hour
 *                   acknowledgement clock is running.
 *  - `acknowledged` a moderator has confirmed receipt. The clock stops here,
 *                   which is exactly what the copy promises within 48 hours.
 *  - `in_review`    the nomination has been tied to a directory listing and is
 *                   collecting the three independent member visits.
 *  - `approved`     the review panel awarded a badge (`awardedTier`).
 *  - `rejected`     the review panel declined it, with `decisionReason`.
 *
 * `rejected` (rather than a new `declined`) is deliberate: rows written before
 * this workflow existed already use it, and adding a synonym would leave the
 * queue filtering on two values that mean the same thing.
 */
export type SafeSpaceNominationStatus =
  'pending' | 'acknowledged' | 'in_review' | 'approved' | 'rejected';

export const SAFE_SPACE_NOMINATION_STATUSES: SafeSpaceNominationStatus[] = [
  'pending',
  'acknowledged',
  'in_review',
  'approved',
  'rejected',
];

/** The states a nomination is still open in, for the operator's queue. */
export const SAFE_SPACE_NOMINATION_OPEN_STATUSES: SafeSpaceNominationStatus[] =
  ['pending', 'acknowledged', 'in_review'];

/**
 * One member's suggestion that a place should be reviewed for the QueerPulse
 * safe-space badge, and the record of what the review team then did about it.
 *
 * This started as an intake queue with no way out of it: rows were written
 * `pending` and no endpoint could move them, while the published copy promised
 * a six-step process. The decision columns below are that process made real —
 * every one of them records who acted, when, and why, so a badge is never just
 * a tier somebody typed.
 *
 * `listingRef` optionally ties the nomination to an existing directory listing
 * (its slug/ref) as the MEMBER typed it; it's null for a free-text place that
 * isn't in the directory yet. `listingId` is the resolved, moderator-confirmed
 * link to that listing's row, set when the nomination is assigned for visits.
 * The two are kept apart on purpose: one is a member's guess, the other is the
 * platform's decision about which business is under review.
 */
@Entity('safe_space_nominations')
export class SafeSpaceNomination {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted nominations still sitting in the moderation queue. It is now `ON DELETE SET NULL`, so
  // NULL here means "the nominator's account was erased" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_safe_space_nominations_nominator_id')
  @Column({ type: 'uuid', nullable: true })
  nominatorId!: string | null;

  @Column({ type: 'varchar', length: 200 })
  placeName!: string;

  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  placeType!: string | null;

  @Column({ type: 'varchar', length: 200, nullable: true })
  listingRef!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Index('IDX_safe_space_nominations_status')
  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status!: SafeSpaceNominationStatus;

  /**
   * The directory listing a moderator confirmed this nomination is about.
   *
   * Plain indexed uuid with NO foreign key to `listings`, matching every other
   * child of that table in this codebase (`ListingReview.listingId`,
   * `ListingModerationEvent.listingId`): a listing being hard-deleted must
   * never take the review record of it with it.
   *
   * Null until the nomination is assigned for visits. Independent member
   * visits are counted against this id, so an unassigned nomination has no
   * visit count at all rather than a misleading zero.
   */
  @Index('IDX_safe_space_nominations_listing_id')
  @Column({ type: 'uuid', nullable: true })
  listingId!: string | null;

  /**
   * When a moderator confirmed receipt. This is the promise the copy makes
   * ("acknowledged within 48 hours") and the only thing that stops the clock;
   * `createdAt` is when it was received, so the two together say whether the
   * platform kept its word. Null while the nomination is still `pending`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  acknowledgedAt!: Date | null;

  /** The moderator who acknowledged it. FK to `users(id)` ON DELETE SET NULL —
   * the record survives its actor erasing their account. */
  @Column({ type: 'uuid', nullable: true })
  acknowledgedBy!: string | null;

  /** When it was assigned for the three independent member visits. */
  @Column({ type: 'timestamptz', nullable: true })
  assignedAt!: Date | null;

  /** The moderator who assigned it. FK ON DELETE SET NULL. */
  @Column({ type: 'uuid', nullable: true })
  assignedBy!: string | null;

  /** What the assigning moderator wants the visitors to look at. */
  @Column({ type: 'text', nullable: true })
  assignmentNote!: string | null;

  /** When the review panel decided, whichever way it went. */
  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /** The moderator who decided. FK ON DELETE SET NULL. */
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  /**
   * Why. Required on every decision, award or decline, so a member who asks
   * "what happened to my nomination" gets an answer written by a person rather
   * than a status string.
   */
  @Column({ type: 'text', nullable: true })
  decisionReason!: string | null;

  /** The tier awarded, mirroring `listings.safe_space_tier`. Null on a
   * decline, and on an approval that predates this column. */
  @Column({ type: 'int', nullable: true })
  awardedTier!: number | null;

  /**
   * When a decided nomination was last re-opened. A decision is never deleted:
   * re-opening clears the decision fields so the nomination can move again and
   * stamps this, while the audit trail keeps the decision that was undone.
   */
  @Column({ type: 'timestamptz', nullable: true })
  reopenedAt!: Date | null;

  /**
   * When the nomination was received. The 48-hour acknowledgement clock is
   * measured from here, which is why nothing else may write it.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
