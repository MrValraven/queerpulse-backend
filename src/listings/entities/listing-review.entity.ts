import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

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
 */
@Entity('listing_reviews')
export class ListingReview {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_listing_reviews_listing_id')
  @Column({ type: 'uuid' })
  listingId: string;

  @Column({ type: 'uuid', nullable: true })
  reviewerId: string | null;

  @Column({ type: 'varchar' })
  reviewerName: string;

  @Column({ type: 'varchar', default: '' })
  byline: string;

  /** 1–5 stars. */
  @Column({ type: 'int' })
  stars: number;

  @Column({ type: 'text' })
  text: string;

  @Column({ type: 'int', default: 0 })
  helpful: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
