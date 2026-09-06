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
 * SELF-ATTESTED AND UNVERIFIED (PRD-249). The author attests that they rented
 * from this landlord and says roughly when, and that attestation is the ONLY
 * thing standing behind the rating. Nothing on this platform can check it. Every
 * read labels the row accordingly and the named landlord has a right of reply
 * through the columns at the bottom of this class.
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

  /**
   * PRD-249. When the author attested, in the act of writing this, that they
   * personally rented from this landlord. NULL means no attestation is on
   * record.
   *
   * REQUIRED IN THE DTO, NULLABLE IN THE COLUMN, and that split is deliberate
   * rather than sloppy. `CreateRecommendationDto` refuses a submission without
   * the attestation, so no row written from today on can have a NULL here. But
   * every row written BEFORE today has one and always will: nobody was asked,
   * so there is no honest value to backfill. A NOT NULL column would have to
   * invent one, which is the exact dishonesty this whole change exists to
   * remove. So NULL reads as "written before the platform asked", the reads
   * below say so on the card, and the column can never be tightened without
   * first asking every historic author again.
   *
   * This is an ATTESTATION, never a verification. Nothing checks it. The
   * platform has no lease, no deposit receipt and no way to reach a landlord
   * who is not a member, so the strongest true claim available is "a
   * phone-verified member said this about themselves". Every read labels it
   * that way. See `LandlordsService.recommend`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  attestedAt!: Date | null;

  /**
   * The rough tenancy window the author attested to, as `YYYY-MM`.
   *
   * MONTH PRECISION, NOT A DATE, and stored as a 7-character varchar rather
   * than a `date` column, because a `date` would claim a day. People remember
   * "spring 2021", not the 14th, and a column that forces a day back from them
   * would store a fiction that the page would then print. Seven characters says
   * exactly as much as the author actually knows.
   *
   * `tenancyStartedOn` is non-null on every attested row (the DTO requires it)
   * and NULL only on the historic rows described above.
   * `tenancyEndedOn` is NULL for two different reasons and the pair has to be
   * read together: NULL alongside a present `attestedAt` means "still renting
   * from them", which is a real and common answer; NULL alongside a NULL
   * `attestedAt` means the row simply predates the question. `attestedAt` is
   * the discriminator, so nothing has to guess.
   */
  @Column({ type: 'varchar', length: 7, nullable: true })
  tenancyStartedOn!: string | null;

  @Column({ type: 'varchar', length: 7, nullable: true })
  tenancyEndedOn!: string | null;

  /**
   * PRD-249, the named landlord's RIGHT OF REPLY, and the reply they wrote.
   * NULL until one is published; publishing again overwrites, so this is one
   * standing reply rather than a thread. The shape mirrors
   * `HousingReview.listerReplyText` / `listerRepliedAt` on purpose, so the two
   * rating surfaces cannot drift.
   *
   * WHERE IT DIFFERS FROM THE HOUSING REVIEW, and the whole difficulty of this
   * surface: a housing lister is a member and posts their own reply. A landlord
   * in this directory has NO ACCOUNT. `Landlord` carries `submittedByUserId`
   * (the member who suggested the entry) and nothing else, and there is no
   * claim path, so there is nobody to authenticate as "this landlord". The
   * reply therefore arrives through the public `landlord_reply_request` intake
   * form, a staff member checks who they are dealing with, and an admin
   * publishes their words here. `landlordReplyPublishedBy` is that admin.
   *
   * That means the words are TRANSCRIBED, and the page must never present them
   * as the landlord typing directly into this platform. The provenance record
   * is the `intake_submissions` row, which carries this recommendation's id in
   * its payload; nothing is duplicated onto this table.
   *
   * WHY IT LIVES ON THE RECOMMENDATION ROW: the reply is a property of the
   * statement it answers. Read apart from that statement it is not the same
   * statement. Same reasoning as `HousingReview.listerReplyText`.
   */
  @Column({ type: 'varchar', length: 2000, nullable: true })
  landlordReplyText!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  landlordReplyPublishedAt!: Date | null;

  /**
   * The admin (`users.id`) who published the reply on the landlord's behalf. No
   * FK, matching `Landlord.decidedBy`: publishing somebody else's words about a
   * named third party is history that has to outlive the staff account that
   * did it.
   */
  @Column({ type: 'uuid', nullable: true })
  landlordReplyPublishedBy!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
