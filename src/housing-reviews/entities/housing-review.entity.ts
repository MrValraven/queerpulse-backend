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
  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted reviews the next tenant relies on. It is now `ON DELETE SET NULL`, so
  // NULL here means "the review was written by a member who has since left" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_housing_reviews_author_id')
  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

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

  /**
   * The LISTER's single public reply to a guest→lister review (PRD-47), and
   * when they wrote it. Both NULL until they answer; posting again overwrites
   * the text and re-stamps the time, so this is one reply rather than a thread.
   *
   * WHY IT LIVES ON THE REVIEW ROW and not in a table of its own: the reply is
   * a property of the statement it answers. Read apart from the review it is
   * not the same statement, which is also why it needs no report subject of its
   * own (see `HousingReviewsService.replyToReview`).
   *
   * WHY ONLY ON A GUEST→LISTER ROW: that is the review the public listing block
   * aggregates, so it is the only one with a public audience for a right of
   * reply to correct. A reply on a lister→guest review would be a second
   * private message between two people who already have a thread. The rule is
   * enforced in the service, not by the schema, because the columns are the
   * same shape either way and a CHECK here would have to be dropped the day the
   * product decides otherwise.
   *
   * WHY A REPLY CANNOT BREAK BLINDNESS: replying proves the lister has read the
   * review, so it is refused until the review has REVEALED (both parties
   * submitted, or the anti-retaliation window elapsed). Reveal is the same
   * predicate the public block uses, so a reply is possible exactly when there
   * is a public audience and never one moment earlier.
   */
  @Column({ type: 'varchar', length: 2000, nullable: true })
  listerReplyText!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  listerRepliedAt!: Date | null;

  /**
   * When the AUTHOR last changed their own review, or NULL for one never
   * edited (the correct reading of every row that predates this column).
   *
   * EDITS CLOSE AT REVEAL, so every stamp this column can now carry is from a
   * still-blind review: you can correct your words up until they go public and
   * not after. That is what keeps the blind window blind, because an edit
   * allowed past reveal would let a member choose their rating only after
   * reading the counterparty's review of them.
   *
   * The stamp still matters after that, because a pre-reveal edit is a real
   * change to a review the counterparty and the public will go on to read, and
   * the page says so ("edited on ..."). Only stamped when something actually
   * changed, so re-saving an identical body writes nothing.
   *
   * ON THE ORDERING FLAG. An edit never clears `listerReplyText`, and comparing
   * this against `listerRepliedAt` is what powers
   * `HousingReviewDTO.isEditedAfterListerReply`. Because a reply is refused
   * before reveal and an edit is refused after it, that comparison can no
   * longer come out true on this surface. Both the guard and the flag are kept
   * regardless: the guard is the line that matters the day the reveal gate
   * moves, and the flag reports the row rather than the policy. See
   * `HousingReviewsService.updateOwnReview`.
   */
  @Column({ type: 'timestamptz', nullable: true })
  editedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
