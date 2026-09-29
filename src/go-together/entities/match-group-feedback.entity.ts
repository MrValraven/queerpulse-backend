import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export const GROUP_CLICK_ANSWERS = ['yes', 'somewhat', 'no'] as const;
export type GroupClickAnswer = (typeof GROUP_CLICK_ANSWERS)[number];

/** One member's answer about the group as a whole, plus "go together again". */
@Entity('match_group_feedback')
@Unique('UQ_match_group_feedback_group_rater', ['groupId', 'raterId'])
export class MatchGroupFeedback {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  groupId!: string;

  @Index('IDX_match_group_feedback_rater_id')
  @Column({ type: 'uuid' })
  raterId!: string;

  @Column({ type: 'varchar', length: 8, nullable: true })
  clicked!: GroupClickAnswer | null;

  @Column({ type: 'boolean', default: false })
  goAgain!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
