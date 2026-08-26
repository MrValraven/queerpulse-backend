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
 * in what happened next. A commission also creates a `MagazinePitch` (carrying
 * `storySubmissionId`) so the piece enters the desk's pitch inbox, and stamps
 * that pitch's id onto `commissionedPitchId`.
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

  /** The `magazine_pitch` row a commission created, for provenance. */
  @Column({ type: 'uuid', nullable: true })
  commissionedPitchId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
