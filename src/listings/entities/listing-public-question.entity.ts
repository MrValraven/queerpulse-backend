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
 * A member's PUBLIC question on a live business listing, and the answer that
 * is posted back underneath it. Both stay on the detail page for the next
 * person with the same question, which is the whole point: "do you have a
 * gender-neutral bathroom", "is the entrance step-free", "do I need to book"
 * get asked over and over, answered privately over and over, and read once.
 *
 * DELIBERATELY A DIFFERENT TABLE FROM `listing_questions`, which is NOT this.
 * That one is the MODERATOR-to-submitter channel used while a listing is still
 * in review: a moderator asks for missing paperwork, the submitter answers, the
 * pair is visible only in the admin drawer. Audience, author, lifecycle and
 * visibility all differ, so overloading one table would have meant every read
 * on either side carrying a "but which kind" predicate, and one missed
 * predicate publishing a moderator's private compliance question on a public
 * page. See `listing-question.entity.ts` for that sibling.
 *
 * `askerName` is snapshotted at ask time exactly as `ListingReview.reviewerName`
 * is, so a question reads consistently after a rename, while the asker's slug
 * and avatar are resolved LIVE at read time from their profile (a changed slug
 * never links to a dead profile). The identity exposed is precisely what a
 * review already exposes for its author: display name, profile slug, avatar.
 * Nothing more.
 *
 * `askerId`/`answeredById` are nullable with `ON DELETE SET NULL`, matching
 * `ListingReview.reviewerId`: an account erasure must not delete public content
 * other members are relying on, it just unlinks the name.
 *
 * `answeredById` is stored rather than inferred from the listing's current
 * owner because a listing can change hands (`ListingClaimsService`), and an
 * answer is a record of who actually spoke. It is also what
 * `answeredByRole` is derived from, which is how a MODERATOR's answer is kept
 * visibly distinct from the business's own words.
 */
@Entity('listing_public_questions')
export class ListingPublicQuestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Leading column of the composite index the public read uses
  // (`IDX_listing_public_questions_listing_id_created_at`), which serves both
  // the `WHERE listing_id = $1` filter and the `ORDER BY created_at DESC` in
  // one index scan.
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  askerId!: string | null;

  @Index('IDX_listing_public_questions_asker_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'asker_id' })
  asker!: User | null;

  /** Snapshotted display name, as `ListingReview.reviewerName` is. */
  @Column({ type: 'varchar' })
  askerName!: string;

  @Column({ type: 'text' })
  body!: string;

  /** Null until somebody answers; the three answer columns move together. */
  @Column({ type: 'text', nullable: true })
  answer!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  answeredAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  answeredById!: string | null;

  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'answered_by_id' })
  answeredBy!: User | null;

  /**
   * True when the answer came from platform staff rather than from the
   * business. Stamped at answer time instead of being recomputed later from
   * `answeredById === listing.ownerId`, because that comparison silently
   * changes its answer when the listing is claimed by someone new: an answer
   * written by a moderator would start rendering as the owner's own words the
   * day an owner is attached. What was true when the words were written does
   * not stop being true afterwards.
   */
  @Column({ type: 'boolean', default: false })
  isAnsweredByModerator!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
