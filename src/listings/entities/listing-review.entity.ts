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

/**
 * A review of a directory listing (business), shown on the public
 * `/local/directory/:slug` detail page and aggregated into the listing's star
 * rating.
 *
 * `reviewerId` is nullable: seeded/imported reviews (from allied partners or
 * clients who aren't members) carry no member link, while a member-submitted
 * review records the author's id. `reviewerName`/`byline` are snapshotted at
 * submit time so a review reads consistently even if the author later changes
 * their profile — mirroring how `Listing.ownerName` snapshots owner identity.
 *
 * Class-level partial unique index (member, listing): at most one
 * member-authored review per (member, listing), scoped `WHERE reviewer_id IS
 * NOT NULL` so seeded/imported reviews (null reviewer) are exempt. Backs
 * `DirectoryService.addReview`'s 23505->409 dedupe recovery — matches
 * `UQ_listing_reviews_reviewer` in
 * `1785600200000-AddListingReviewReviewerDedupeIndex`.
 */
@Index('UQ_listing_reviews_reviewer', ['listingId', 'reviewerId'], {
  unique: true,
  where: `"reviewer_id" IS NOT NULL`,
})
@Entity('listing_reviews')
export class ListingReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_listing_reviews_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  reviewerId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL (see
  // `1785600300000-AddUserRefForeignKeys`): an account-erasure hard-delete
  // nulls `reviewerId` out while the review survives. Declared as a relation so
  // metadata and schema agree and `migration:generate` won't emit a DROP.
  @Index('IDX_listing_reviews_reviewer_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'reviewer_id' })
  reviewer!: User | null;

  @Column({ type: 'varchar' })
  reviewerName!: string;

  @Column({ type: 'varchar', default: '' })
  byline!: string;

  /** 1–5 stars. */
  @Column({ type: 'int' })
  stars!: number;

  @Column({ type: 'text' })
  text!: string;

  @Column({ type: 'int', default: 0 })
  helpful!: number;

  /**
   * The listing owner's single public reply to this review, set via the
   * owner-gated `PATCH /listings/:ref/reviews/:reviewId/reply`. Both columns
   * are null until a reply is posted; posting again overwrites them
   * (idempotent update, not a reply thread).
   */
  @Column({ type: 'text', nullable: true })
  ownerReplyText!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  ownerRepliedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
