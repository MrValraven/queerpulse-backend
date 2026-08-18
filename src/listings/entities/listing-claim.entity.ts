import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Review lifecycle for a member's claim on an existing (unowned/"friendly")
 * business listing. */
export enum ListingClaimStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

/**
 * A member's request to take ownership of an EXISTING listing (`POST
 * /listings/:ref/claim`), reviewed by a moderator (`PATCH
 * /listings/admin/claims/:id`). Distinct from `POST /listings`, which always
 * creates a brand-new row owned by the caller — a claim instead reassigns an
 * existing listing's `ownerId` on approval, so the listing's history/reviews/
 * ref survive.
 *
 * `listingId` deliberately carries NO foreign key to `listings` — mirrors
 * `ListingModerationEvent.listingId`/`ListingQuestion.listingId`/
 * `ListingReview.listingId`'s identical precedent, so a moderator hard-deleting
 * a listing never cascades away the claim record that documents the request.
 *
 * `claimantId` is nullable with an `ON DELETE SET NULL` FK to `users(id)`
 * (never CASCADE — mirrors `ListingReview.reviewer`/
 * `ListingEditSuggestion.suggestedByUser`'s identical precedent): an
 * account-erasure hard-delete nulls the claimant out while the claim record
 * (and the moderator's eventual decision on it) survives.
 *
 * Class-level partial unique index: at most one OPEN (`pending`) claim per
 * (listing, claimant) — mirrors `ListingReview`'s
 * `UQ_listing_reviews_reviewer` / `CommunityJoinRequest`'s
 * `UQ_community_join_requests_pending` shape. `ListingClaimsService.requestClaim`
 * dedupes on this: a member re-submitting a claim while one is already open
 * gets the existing claim back rather than piling rows on the mods' desk.
 */
@Index('UQ_listing_claims_pending_claimant', ['listingId', 'claimantId'], {
  unique: true,
  where: `"status" = 'pending'`,
})
@Entity('listing_claims')
export class ListingClaim {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_listing_claims_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  claimantId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL (never CASCADE — see class doc
  // comment). Relation kept alongside the scalar so metadata and schema agree
  // and `migration:generate` won't emit a DROP.
  @Index('IDX_listing_claims_claimant_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'claimant_id' })
  claimant!: User | null;

  /** Free-text explanation the claimant gives a moderator ("I'm the owner,
   * here's how to verify me…"). */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Index('IDX_listing_claims_status')
  @Column({
    type: 'enum',
    enum: ListingClaimStatus,
    enumName: 'listing_claims_status_enum',
    default: ListingClaimStatus.Pending,
  })
  status!: ListingClaimStatus;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  // FK to `users(id)` ON DELETE SET NULL, same rationale as `claimant` above.
  @Index('IDX_listing_claims_reviewed_by')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewed_by' })
  reviewer!: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
