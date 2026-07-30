import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Review lifecycle for a member-submitted correction to a business listing. */
export enum ListingEditSuggestionStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Dismissed = 'dismissed',
}

/**
 * A non-owner member's proposed correction to a business listing ("suggest an
 * edit" — e.g. "the hours are wrong", "phone number changed"), landing in a
 * moderator-reviewable queue (`GET /listings/admin/edit-suggestions`).
 *
 * Deliberately a separate entity from `Report`/`ReportSubjectType`
 * (`src/reports`): a report flags a problem for moderation action against the
 * listing/owner and carries a reason code + severity, while this carries
 * proposed-change data (`field` + `message`) with its own accept/dismiss
 * resolution model — reusing the reports entity would force an unrelated
 * shape onto a correction.
 *
 * `suggestedByUserId` is nullable for the same reason `ListingReview.reviewerId`
 * is: an account-deletion erasure sweep should be able to null out the
 * identity without forcing the whole moderation row to disappear. No FK is
 * declared on it (mirrors `listing_reviews.reviewer_id`), so an erasure that
 * hard-deletes the `users` row doesn't need to know this table exists.
 */
@Entity('listing_edit_suggestions')
export class ListingEditSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_listing_edit_suggestions_listing_id')
  @Column({ type: 'uuid' })
  listingId: string;

  @Column({ type: 'uuid', nullable: true })
  suggestedByUserId: string | null;

  // One of `EDIT_SUGGESTION_FIELDS` (`create-edit-suggestion.dto.ts`), stored
  // as a plain varchar (not a DB enum) so the FE's field picker can grow
  // without a migration — mirrors `MagazineStorySubmission.format`'s
  // precedent for the same reason.
  @Column({ type: 'varchar' })
  field: string;

  @Column({ type: 'text' })
  message: string;

  @Index('IDX_listing_edit_suggestions_status')
  @Column({
    type: 'enum',
    enum: ListingEditSuggestionStatus,
    enumName: 'listing_edit_suggestions_status_enum',
    default: ListingEditSuggestionStatus.Pending,
  })
  status: ListingEditSuggestionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId: string | null;
}
