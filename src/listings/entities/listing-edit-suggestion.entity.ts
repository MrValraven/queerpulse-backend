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

/** Review lifecycle for a member-submitted correction to a business listing. */
export enum ListingEditSuggestionStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Dismissed = 'dismissed',
}

/**
 * A non-owner member's proposed correction to a business listing ("suggest an
 * edit" — e.g. "the hours are wrong", "phone number changed"), landing in a
 * moderator-reviewable queue (`GET /admin/listings/edit-suggestions`).
 *
 * Deliberately a separate entity from `Report`/`ReportSubjectType`
 * (`src/reports`): a report flags a problem for moderation action against the
 * listing/owner and carries a reason code + severity, while this carries
 * proposed-change data (`field` + `message`) with its own accept/dismiss
 * resolution model — reusing the reports entity would force an unrelated
 * shape onto a correction.
 *
 * `suggestedByUserId`/`resolvedByUserId` are nullable for the same reason
 * `ListingReview.reviewerId` is: an account-deletion erasure sweep should be
 * able to null out the identity without forcing the whole moderation row to
 * disappear. Both carry an `ON DELETE SET NULL` FK to `users(id)` (see
 * `1785600300000-AddUserRefForeignKeys`) so an erasure hard-delete nulls the
 * ref rather than leaving a dangling UUID.
 */
@Entity('listing_edit_suggestions')
export class ListingEditSuggestion {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_listing_edit_suggestions_listing_id')
  @Column({ type: 'uuid' })
  listingId!: string;

  @Column({ type: 'uuid', nullable: true })
  suggestedByUserId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL (see
  // `1785600300000-AddUserRefForeignKeys`). Relation kept alongside the scalar
  // so metadata and schema agree and `migration:generate` won't emit a DROP.
  @Index('IDX_listing_edit_suggestions_suggested_by_user_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'suggested_by_user_id' })
  suggestedByUser!: User | null;

  // One of `EDIT_SUGGESTION_FIELDS` (`create-edit-suggestion.dto.ts`), stored
  // as a plain varchar (not a DB enum) so the FE's field picker can grow
  // without a migration — mirrors `MagazineStorySubmission.format`'s
  // precedent for the same reason.
  @Column({ type: 'varchar' })
  field!: string;

  @Column({ type: 'text' })
  message!: string;

  /**
   * The suggester's optional typed replacement value: the exact new phone
   * number or closing time, rather than only prose describing that the current
   * one is wrong. `null` when they reported a problem without knowing the fix,
   * which stays a valid submission (`message` is the required half).
   *
   * Validated at submit time against the rules the target `Listing` column
   * enforces (`accepted-suggestion-value.ts`), and re-validated on accept
   * before it is written, so a row can never carry a value the create path
   * would have refused.
   *
   * `text`, matching `message`, rather than a per-target width: the column it
   * eventually lands on depends on `field`, whose own widths (60 for phone, 300
   * for address) are enforced by the validators instead. Nullable because every
   * row that existed before this column did carries prose alone.
   */
  @Column({ type: 'text', nullable: true })
  proposedValue!: string | null;

  @Index('IDX_listing_edit_suggestions_status')
  @Column({
    type: 'enum',
    enum: ListingEditSuggestionStatus,
    enumName: 'listing_edit_suggestions_status_enum',
    default: ListingEditSuggestionStatus.Pending,
  })
  status!: ListingEditSuggestionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  // FK to `users(id)` ON DELETE SET NULL (see
  // `1785600300000-AddUserRefForeignKeys`). Relation kept alongside the scalar
  // so metadata and schema agree and `migration:generate` won't emit a DROP.
  @Index('IDX_listing_edit_suggestions_resolved_by_user_id')
  @ManyToOne(() => User, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'resolved_by_user_id' })
  resolvedByUser!: User | null;
}
