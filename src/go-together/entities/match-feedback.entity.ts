import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export const MEET_AGAIN_VERDICTS = ['yes', 'maybe', 'no'] as const;
export type MeetAgainVerdict = (typeof MEET_AGAIN_VERDICTS)[number];

/** One member's private "meet again?" answer about one other group member. */
@Entity('match_feedback')
@Unique('UQ_match_feedback_group_rater_ratee', [
  'groupId',
  'raterId',
  'rateeId',
])
export class MatchFeedback {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** Lookups by group use the unique constraint's leading column. */
  @Column({ type: 'uuid' })
  groupId!: string;

  @Index('IDX_match_feedback_rater_id')
  @Column({ type: 'uuid' })
  raterId!: string;

  @Index('IDX_match_feedback_ratee_id')
  @Column({ type: 'uuid' })
  rateeId!: string;

  @Column({ type: 'varchar', length: 8 })
  verdict!: MeetAgainVerdict;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
