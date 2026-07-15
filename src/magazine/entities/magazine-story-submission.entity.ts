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
 * A reader-submitted story pitch (`SubmitStoryPage.tsx` / `SubmitStoryEditor`
 * "Submit for review"). The only write this module exposes. `userId` is the
 * submitting member (`users.id`) — submissions have no `magazine_author` row
 * (that's for curated bylines, not pitches).
 */
@Entity('magazine_story_submission')
export class MagazineStorySubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_magazine_story_submission_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  format: string;

  @Column({ type: 'varchar' })
  workingTitle: string;

  @Column({ type: 'text' })
  pitch: string;

  @Column({
    type: 'enum',
    enum: SubmissionStatus,
    enumName: 'magazine_submission_status_enum',
    default: SubmissionStatus.Submitted,
  })
  status: SubmissionStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
