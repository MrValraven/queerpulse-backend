import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** Mirrors contracts.ts `SubmissionStatus` exactly. */
export enum SubmissionStatus {
  Draft = 'draft',
  Submitted = 'submitted',
  InReview = 'in_review',
  Accepted = 'accepted',
  Rejected = 'rejected',
  Published = 'published',
}

/**
 * The editorial outcome a staff decider recorded on a submission. Stored as a
 * `varchar` string union (repo idiom: no second Postgres `CREATE TYPE`)
 * ALONGSIDE `status` rather than inside it, because `status` is a published
 * contract shared with the frontend's `SubmissionStatus` and widening it would
 * break every exhaustive map keyed on it.
 *
 * `accepted` and `commissioned` both land `status` on `Accepted`; they differ
 * in what happens on the desk. A commission creates a `MagazinePitch` (carrying
 * `storySubmissionId`) so the story enters the desk's pitch inbox to be
 * triaged, and stamps that pitch's id onto `commissionedPitchId`. An
 * acceptance skips the inbox and creates the `MagazinePiece` outright, with
 * the member's own text already filed as its article draft, stamping
 * `acceptedPieceId`.
 */
export type SubmissionDecision = 'accepted' | 'declined' | 'commissioned';

/**
 * A reader-submitted story (`SubmitStoryPage.tsx` / `SubmitStoryEditor`
 * "Submit for review"). `userId` is the submitting member (`users.id`) —
 * submissions have no `magazine_author` row (that's for curated bylines, not
 * pitches).
 *
 * The member writes a full piece, so the parts arrive and are stored SEPARATELY
 * (CON-01): `pitch` is the short summary line, `deck` the standfirst, `body`
 * the piece itself, `coverImageKey` the storage key of the cover they uploaded.
 * `deck`/`body`/`coverImageKey` are nullable because rows written before that
 * split carry the whole thing concatenated into `pitch` — reading code must
 * fall back to `pitch` rather than assume `body` is populated.
 */
@Entity('magazine_story_submission')
export class MagazineStorySubmission {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_magazine_story_submission_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  format!: string;

  @Column({ type: 'varchar' })
  workingTitle!: string;

  /** The short summary the member wrote (their deck, or an excerpt of the
   *  body when they left the deck empty). Pre-CON-01 rows hold deck and body
   *  concatenated here instead. */
  @Column({ type: 'text' })
  pitch!: string;

  /** The standfirst, as its own field. Null on pre-CON-01 rows. */
  @Column({ type: 'text', nullable: true })
  deck!: string | null;

  /** The piece itself. Null on pre-CON-01 rows (see `pitch`). */
  @Column({ type: 'text', nullable: true })
  body!: string | null;

  /**
   * Storage key of the cover the member uploaded through
   * `useUploadImage("story-cover")`. It used to be uploaded and then dropped on
   * the floor — the platform charged the member the upload and threw the file
   * away. Validated by `@IsImageReference` on the create DTO and covered by a
   * `MediaReferenceSource` (`MagazineStorySubmission.coverImageKey`) so the
   * my-media/admin-media "where is this used?" surfaces see it.
   */
  @Column({ type: 'varchar', nullable: true })
  coverImageKey!: string | null;

  @Column({
    type: 'enum',
    enum: SubmissionStatus,
    enumName: 'magazine_submission_status_enum',
    default: SubmissionStatus.Submitted,
  })
  status!: SubmissionStatus;

  /** Null until staff decide. See {@link SubmissionDecision}. */
  @Column({ type: 'varchar', nullable: true })
  decision!: SubmissionDecision | null;

  /** The optional note the decider wrote back to the submitter. */
  @Column({ type: 'text', nullable: true })
  decisionNote!: string | null;

  /** The staff member who decided. Indexed because Postgres does not index a
   *  foreign-key column automatically, and this one is ON DELETE SET NULL. */
  @Index('IDX_magazine_story_submission_decided_by')
  @Column({ type: 'uuid', nullable: true })
  decidedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  decidedAt!: Date | null;

  /**
   * The three columns below record that a DECLINE was taken back and the story
   * put back in the queue (`AdminStorySubmissionsService.reopen`).
   *
   * A decline used to be permanent: `decide` refuses a second decision, so an
   * editor who pressed the wrong button, changed their mind, or read a revised
   * version had no route back and the member's story was finished. Reopening
   * clears `decision`, `decisionNote`, `decidedBy` and `decidedAt`, which is
   * the only way `list` will show the row again. That erasure is the problem
   * these columns solve: without them the reopened row is indistinguishable
   * from one that was never decided at all, and the editor who wrote the
   * decline would find it back in the queue with nothing explaining why.
   *
   * `reopenCount` exists because `reopenedAt`/`reopenedBy` only ever hold the
   * LAST reopen. A story that has been round the decline-and-reopen loop three
   * times is a different conversation from one reopened once, and that is a
   * signal about how the desk is treating a member.
   *
   * Stamped columns rather than a history table, matching `withdrawnAt`
   * (PRD-129) and the module's existing habit: `magazine_story_submission` has
   * no audit trail of its own, and the desk's audit trail
   * (`magazine_piece_event`) is keyed on a piece, which a declined submission
   * by definition does not have. A full per-decision history would need its own
   * table; see the note on `reopen`.
   */
  @Index('IDX_magazine_story_submission_reopened_by')
  @Column({ type: 'uuid', nullable: true })
  reopenedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reopenedAt!: Date | null;

  @Column({ type: 'int', default: 0 })
  reopenCount!: number;

  /**
   * When the member who wrote this story pulled it back, before the desk had
   * answered (PRD-129). Null on every submission that is still open or already
   * decided.
   *
   * A soft mark rather than a delete: the row is evidence for both sides if the
   * story is ever argued about later, and the instant matters (withdrawing an
   * hour after filing and withdrawing after an editor has read it are different
   * conversations). Both read paths filter on it, so a withdrawn story stops
   * appearing as awaiting an answer on the member's tracker AND in the desk
   * queue, and `decide` refuses it.
   *
   * Deliberately its own column instead of a new `SubmissionStatus` value:
   * `status` is a published contract the frontend mirrors verbatim, and every
   * client map keyed on it is exhaustive, so widening it would render a raw
   * machine value at any client that had not shipped the new arm.
   */
  @Column({ type: 'timestamptz', nullable: true })
  withdrawnAt!: Date | null;

  /** The `magazine_pitch` row a commission created, for provenance. */
  @Column({ type: 'uuid', nullable: true })
  commissionedPitchId!: string | null;

  /**
   * The `magazine_piece` an ACCEPTANCE created, for provenance.
   *
   * An accept used to stamp `status` and ring the member and stop there: the
   * reader was told the magazine had taken their story, and the desk got no
   * piece, no editor, no article draft and no payment row. The only way onto
   * the desk was to copy the text out of this admin row by hand, and because
   * a decision is final the story could never be commissioned afterwards
   * either. Accepting now creates the piece, and this column is the link back
   * to it, mirroring `commissionedPitchId` on the commission path.
   *
   * It also makes the accept idempotent: it is claimed with a conditional
   * `IS NULL` UPDATE inside the same transaction that creates the piece, so
   * one submission can never end up with two desk pieces.
   *
   * Indexed for the same reason `decidedBy` is: Postgres does not index a
   * foreign-key column on its own, and this one is `ON DELETE SET NULL`.
   */
  @Index('IDX_magazine_story_submission_accepted_piece')
  @Column({ type: 'uuid', nullable: true })
  acceptedPieceId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
