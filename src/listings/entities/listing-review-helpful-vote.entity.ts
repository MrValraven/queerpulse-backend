import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { ListingReview } from './listing-review.entity';
import { User } from '../../users/entities/user.entity';

/**
 * One member's "this review was helpful" vote on one directory review.
 *
 * `ListingReview.helpful` used to be written as a literal `0` at submit time
 * with no endpoint able to move it, so the number on the page was decoration.
 * These rows are what the number now counts.
 *
 * ONE VOTE PER MEMBER PER REVIEW IS A DATABASE RULE, not an application one:
 * the class-level unique index below (`UQ_listing_review_helpful_votes_voter`,
 * matching the constraint of the same name in
 * `1794270000000-CreateListingReviewHelpfulVotes`) is what actually holds the
 * line, exactly as `UQ_listing_reviews_reviewer` holds the one-review-per-
 * member line on the parent table. The write path inserts with `ON CONFLICT DO
 * NOTHING`, so a double-tap converges on the single existing row rather than
 * raising, and two concurrent first votes from one member can never both land.
 *
 * The self-vote rule ("you cannot mark your own review helpful") is checked in
 * the service instead, and it has to be: it is a predicate across two tables
 * (`listing_review_helpful_votes.voter_id` vs `listing_reviews.reviewer_id`),
 * which a Postgres CHECK constraint cannot express. A trigger could, at the
 * cost of putting business logic somewhere no reader of this module would look.
 *
 * Both foreign keys CASCADE. A deleted review takes its votes with it (they
 * mean nothing without it), and an erased account's votes disappear rather
 * than lingering as nullable rows. This deliberately differs from
 * `ListingReview.reviewerId`'s erasure-safe `ON DELETE SET NULL`: a review is
 * content with standalone meaning that must survive its author, while a vote
 * is a tally entry with none. Mirrors `resource_guide_rating`'s reasoning.
 */
@Index('UQ_listing_review_helpful_votes_voter', ['reviewId', 'voterId'], {
  unique: true,
})
@Entity('listing_review_helpful_votes')
export class ListingReviewHelpfulVote {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // The leading column of the unique index above, so the per-review recount
  // (`COUNT(*) WHERE review_id = $1`) reads that index and needs no second one.
  @Column({ type: 'uuid' })
  reviewId!: string;

  @ManyToOne(() => ListingReview, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'review_id' })
  review!: ListingReview;

  @Column({ type: 'uuid' })
  voterId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'voter_id' })
  voter!: User;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
