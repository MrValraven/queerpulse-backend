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

  /**
   * Denormalized count of `listing_review_helpful_votes` rows for this review.
   * Kept in step with those rows by `DirectoryService.voteHelpful` /
   * `withdrawHelpfulVote`, which RECOMPUTE it from `COUNT(*)` inside the same
   * transaction as the vote write rather than incrementing it. An increment
   * drifts the moment one write is retried, replayed, or lost; a recount is
   * self-healing, and it costs one index-only scan over a single review's
   * votes.
   *
   * Before those endpoints existed this column was written as a literal `0`
   * and never moved, so the number rendered on the page was decoration.
   */
  @Column({ type: 'int', default: 0 })
  helpful!: number;

  /**
   * One optional photo attached by the reviewer, holding a storage key from
   * the shared `POST /uploads/presign` flow under the EXISTING `listing-photo`
   * upload kind (see `upload-kinds.ts`) rather than a new one: it renders on
   * the same public directory page, under the same 5 MB cap, with the same
   * `requiresSession: false` read visibility, so a second kind would have been
   * a second name for one thing.
   *
   * Uploads are presigned and go direct to storage, which means the API never
   * sees the bytes and the CLIENT is the only place image metadata (EXIF, GPS)
   * is stripped. Nothing here can re-check that, which is exactly why this
   * column follows the established path instead of a bespoke one.
   *
   * `''` means "no photo", matching `Listing.photos`'s slots and
   * `@IsImageReference`'s empty-string convention; `toImageUrl('')` normalises
   * it to `null` at the response boundary.
   */
  @Column({ type: 'varchar', default: '' })
  photo!: string;

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

  /**
   * When the reviewer last changed their own review (`PATCH
   * /directory/:slug/reviews/:reviewId`). Null for a review never edited.
   *
   * Stamped only when something actually changed, so re-saving an identical
   * body does not manufacture an edit. Read alongside `ownerRepliedAt`: an
   * `editedAt` LATER than `ownerRepliedAt` means the owner's reply answers
   * words that no longer stand, and `ReviewDTO.isEditedAfterOwnerReply` says
   * so on the page. See `DirectoryService.updateReview` for why the reply is
   * kept rather than cleared.
   */
  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
