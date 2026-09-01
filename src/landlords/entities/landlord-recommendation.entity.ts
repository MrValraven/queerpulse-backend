import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * One member's recommendation of a landlord (stars + text). One per member per
 * landlord (unique `(landlordId, authorUserId)`); re-posting upserts. Author
 * identity is hydrated live via `MemberLookup`, not snapshotted.
 *
 * TAKEDOWN. A recommendation is withheld through the shared
 * `content_moderation` table under the `landlord_recommendation` subject,
 * keyed by this row's uuid, exactly as a directory review is withheld under
 * `review`. Nothing on this entity records that state: the row is left
 * untouched so lifting the takedown restores the original words. Every member
 * read and every star aggregate in `LandlordsService` filters on it. See
 * `LandlordsService.RECOMMENDATION_SUBJECT_TYPE`.
 */
@Entity('landlord_recommendations')
@Index('UQ_landlord_recommendations_author', ['landlordId', 'authorUserId'], {
  unique: true,
})
export class LandlordRecommendation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_landlord_recommendations_landlord_id')
  @Column({ type: 'uuid' })
  landlordId!: string;

  // NULLABLE since `SetNullLandlordRecommendationAuthorFk1797900000000`. The FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account deleted
  // the warnings other tenants were relying on and silently moved the
  // landlord's aggregate rating with them. It is now `ON DELETE SET NULL`, so
  // NULL here means "written by a member who has since left" rather than "no
  // such row". It is the same meaning `housing_reviews.author_id` and
  // `listing_reviews.reviewer_id` carry. Read paths must render a
  // removed-member placeholder instead of assuming a non-null id.
  //
  // The unique index above is a PLAIN unique index, and Postgres treats NULLs
  // as distinct under one, so several anonymised recommendations can coexist on
  // the same landlord. That is deliberate: each was a different tenant's
  // warning, and collapsing them would be a second, silent erasure. The index
  // still does its real job, which is stopping one PRESENT member from rating
  // the same landlord twice.
  @Index('IDX_landlord_recommendations_author_user_id')
  @Column({ type: 'uuid', nullable: true })
  authorUserId!: string | null;

  @Column({ type: 'int' })
  stars!: number;

  @Column({ type: 'text' })
  text!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
