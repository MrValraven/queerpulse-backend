import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

/** Which side of the viewing the author was. A guest→lister review is what the
 * public listing display aggregates; a lister→guest review stays between the
 * two parties. */
export enum HousingReviewAuthorRole {
  Requester = 'requester',
  Lister = 'lister',
}

/**
 * One party's BLIND review of the other, written after a COMPLETED viewing
 * (P2.4). Blindness is enforced on the READ path (see
 * `HousingReviewsService`): neither party sees the other's review until both
 * have submitted OR a fixed window elapses — so this row stores only the
 * submission, never a "revealed" flag. Exactly one review per (viewing, author)
 * via the composite unique index.
 *
 * A SECOND uniqueness rule sits alongside it (BE-HSG-09): one review per
 * (listing, author, author_role). Per-viewing uniqueness alone let the same
 * member review one listing over and over, once per viewing they opened on it,
 * which is what made the "real recorded interaction" premise above forgeable.
 * Declared in migration `AddHousingViewingAndReviewUniqueness1793530600000` as
 * `UQ_housing_reviews_listing_author`.
 */
@Entity('housing_reviews')
@Index('UQ_housing_reviews_viewing_author', ['viewingId', 'authorId'], {
  unique: true,
})
@Index(
  'UQ_housing_reviews_listing_author',
  ['listingId', 'authorId', 'authorRole'],
  { unique: true },
)
export class HousingReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // The completed viewing this review is gated on.
  @Index('IDX_housing_reviews_viewing_id')
  @Column({ type: 'uuid' })
  viewingId!: string;

  // Denormalized listing, so the public listing display aggregates in one query.
  @Index('IDX_housing_reviews_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  // Who wrote it.
  @Index('IDX_housing_reviews_author_id')
  @Column({ type: 'uuid' })
  authorId!: string;

  // Who it is about (the other participant).
  @Index('IDX_housing_reviews_subject_id')
  @Column({ type: 'uuid' })
  subjectId!: string;

  @Column({
    type: 'enum',
    enum: HousingReviewAuthorRole,
    enumName: 'housing_review_author_role_enum',
  })
  authorRole!: HousingReviewAuthorRole;

  // 1–5, validated on input.
  @Column({ type: 'int' })
  rating!: number;

  @Column({ type: 'varchar', length: 1000, default: '' })
  text!: string;

  // Stamped at submission — the anchor for the blind-reveal window.
  @Column({ type: 'timestamptz' })
  submittedAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
