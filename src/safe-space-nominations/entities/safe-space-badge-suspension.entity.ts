import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What put a badge under suspension. */
export type SafeSpaceSuspensionCause = 'flag_threshold' | 'moderator';

export const SAFE_SPACE_SUSPENSION_CAUSES: SafeSpaceSuspensionCause[] = [
  'flag_threshold',
  'moderator',
];

/**
 * A temporary suspension of one listing's safe-space badge: the "three flags
 * trigger an immediate review and temporary suspension" half of the published
 * promise.
 *
 * A SIDE TABLE RATHER THAN COLUMNS ON `listings`, for the reason
 * `ContentModeration` states for itself: the state belongs to moderation, not
 * to the business, and keeping it out of the listing row keeps a suspension
 * cleanly distinct from the badge grant it suspends. `safe_space_status` stays
 * `verified` throughout, because the badge WAS granted and the grant is not
 * being rewritten. What changes is whether it currently speaks for the place.
 * Removal is a different act with a different column (`removed`) and a
 * different narrative (`safe_space_removal`), and conflating the two would make
 * "we are looking into this" indistinguishable from "we took it away".
 *
 * A suspension is OPEN while `lifted_at IS NULL`. A partial UNIQUE index over
 * `listing_id` on that predicate guarantees one open suspension per listing, so
 * a burst of flags crossing the threshold concurrently cannot open two.
 */
@Entity('safe_space_badge_suspensions')
export class SafeSpaceBadgeSuspension {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Plain indexed uuid, no FK to `listings` — see `SafeSpaceFlag`. */
  @Index('IDX_safe_space_badge_suspensions_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'varchar', length: 20 })
  cause!: SafeSpaceSuspensionCause;

  /**
   * How many open flags stood against the space at the moment it was
   * suspended. A snapshot, deliberately not recomputed: it is the evidence the
   * threshold was actually crossed, and later withdrawals must not rewrite it.
   */
  @Column({ type: 'int', default: 0 })
  flagCountAtSuspension!: number;

  /** Set only for `cause = 'moderator'`. FK to `users(id)` ON DELETE SET NULL.
   * A threshold suspension has no actor: the platform kept its own promise. */
  @Column({ type: 'uuid', nullable: true })
  suspendedBy!: string | null;

  /** Moderator-authored on a manual suspension; platform-authored on a
   * threshold one. Shown to the venue owner, so it never names a flagger. */
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  liftedAt!: Date | null;

  /** The moderator who lifted it. FK to `users(id)` ON DELETE SET NULL. */
  @Column({ type: 'uuid', nullable: true })
  liftedBy!: string | null;

  @Column({ type: 'text', nullable: true })
  liftReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
