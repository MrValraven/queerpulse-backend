import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('company_reviews')
@Unique('UQ_company_reviews', ['companyId', 'authorId'])
export class CompanyReview {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_company_reviews_company_id')
  @Column({ type: 'uuid' })
  companyId!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted reviews the next applicant relies on. It is now `ON DELETE SET NULL`, so
  // NULL here means "the review was written by a member who has since left" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_company_reviews_author_id')
  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'int' })
  stars!: number;

  @Column({ type: 'varchar' })
  byline!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  body!: string[];

  /**
   * The EMPLOYER's single public reply to this review, set via the owner-gated
   * `PATCH /companies/:slug/reviews/:reviewId/reply`. Both columns are null
   * until a reply is posted; posting again overwrites them (idempotent update,
   * never a reply thread).
   *
   * Named `ownerReply*` rather than `employerReply*` on purpose: this is the
   * same column pair as `listing_reviews.owner_reply_text` /
   * `owner_replied_at`, holding the same thing (the reviewed subject's one
   * public answer), and PRD-47 is about the five review primitives converging
   * on ONE shape. The word the reader sees is "employer", which is the
   * frontend's job.
   *
   * Only a CLAIMED company has anyone who can write here: `companies.owner_id`
   * is nullable and NULL means unclaimed, so the reply is gated on a non-null
   * owner matching the caller. See `CompaniesService.replyToReview`.
   */
  @Column({ type: 'text', nullable: true })
  ownerReplyText!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  ownerRepliedAt!: Date | null;

  /**
   * When the review's AUTHOR last changed it (`PATCH
   * /companies/:slug/reviews/:reviewId`). Null for a review never edited.
   *
   * Stamped only when something actually changed, so re-saving an identical
   * body cannot manufacture an edit against an employer. Read alongside
   * `ownerRepliedAt`: an `editedAt` LATER than `ownerRepliedAt` means the
   * employer's reply answers words that no longer stand, and
   * `CompanyReviewDTO.isEditedAfterOwnerReply` says so on the page. See
   * `CompaniesService.updateReview` for why the reply is kept rather than
   * cleared.
   */
  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
