import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Why a member is flagging a badged safe space. A closed set kept as varchar
 * (not a PG enum) for the same reason every other status code in this domain
 * is: a new reason must not need an `ALTER TYPE`. The DTO's `@IsIn` is the
 * write-time guard.
 */
export type SafeSpaceFlagReason =
  | 'not_safe'
  | 'discrimination'
  | 'staff_conduct'
  | 'accessibility'
  | 'closed_or_changed'
  | 'other';

export const SAFE_SPACE_FLAG_REASONS: SafeSpaceFlagReason[] = [
  'not_safe',
  'discrimination',
  'staff_conduct',
  'accessibility',
  'closed_or_changed',
  'other',
];

/** How a moderator closed a flag. */
export type SafeSpaceFlagResolution = 'upheld' | 'dismissed';

export const SAFE_SPACE_FLAG_RESOLUTIONS: SafeSpaceFlagResolution[] = [
  'upheld',
  'dismissed',
];

/**
 * One member's flag against a badged safe space.
 *
 * WHY A TABLE AND NOT THE EXISTING JSONB. `listings.safe_space_removal` already
 * carries a `flags: number`, and it cannot honestly carry this. It is a single
 * nullable jsonb blob describing a REMOVAL narrative, populated only once a
 * badge is already gone, holding one integer with no author, no reason, no
 * timestamp and no per-flag state. Three flags have to be three distinguishable
 * people with three distinguishable reasons, or the "three flags trigger a
 * review" promise cannot be enforced (nothing stops one member counting three
 * times), a moderator cannot resolve one flag without rewriting the others, and
 * a flagger can never be told what happened to the thing they raised. A blob
 * also has no unique index, so idempotency and rate limiting would both be
 * best-effort application logic over a value two concurrent writes can clobber.
 *
 * FLAGGER IDENTITY IS PRIVATE. `flaggerId` never leaves the moderator-facing
 * DTO. The venue owner is told their badge is under review and never who
 * raised it, exactly as a report author is never disclosed to the person
 * reported. That is the whole reason a member will use this at all.
 *
 * `listingId` is a plain indexed uuid with NO foreign key to `listings`, the
 * same choice `ListingModerationEvent` documents: hard-deleting a listing must
 * not erase the safety record of it. `flaggerId` IS a real FK to `users(id)`
 * ON DELETE SET NULL, matching `ListingReview.reviewerId`: an erased account
 * leaves the flag standing and unattributed rather than silently lowering the
 * count that suspended a badge.
 *
 * OPEN means `withdrawn_at IS NULL AND resolved_at IS NULL`. A partial UNIQUE
 * index over `(listing_id, flagger_id)` on exactly that predicate is what makes
 * a duplicate flag idempotent while still letting a member raise a fresh one
 * after the last was resolved.
 */
@Entity('safe_space_flags')
export class SafeSpaceFlag {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_safe_space_flags_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  /** Null once the flagger's account is erased — see the class doc comment. */
  @Index('IDX_safe_space_flags_flagger_id')
  @Column({ type: 'uuid', nullable: true })
  flaggerId!: string | null;

  @Column({ type: 'varchar', length: 40 })
  reasonCode!: SafeSpaceFlagReason;

  /** The member's own words. Moderator-only; it never reaches the owner. */
  @Column({ type: 'text', nullable: true })
  detail!: string | null;

  /** The flagger took it back. Excluded from the open count immediately, and
   * never auto-lifts a suspension: only a moderator does that. */
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /** The moderator who closed it. FK to `users(id)` ON DELETE SET NULL. */
  @Column({ type: 'uuid', nullable: true })
  resolvedBy!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  resolution!: SafeSpaceFlagResolution | null;

  /** Why it was upheld or dismissed. Moderator-authored. */
  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
