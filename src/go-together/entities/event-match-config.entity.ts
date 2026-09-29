import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { HostQuestion } from '../go-together-questionnaire.catalog';

/**
 * The host's Go together settings for one gathering. `matchedAt`,
 * `lateGroupAt` and `feedbackPromptedAt` are at-most-once claim columns for the
 * cron passes: each pass stamps its column with a conditional UPDATE and only
 * the replica whose UPDATE returned the row does the work.
 */
@Entity('event_match_configs')
@Index('IDX_event_match_configs_due', ['cutoffAt'], {
  where: '"enabled" = true AND "matched_at" IS NULL',
})
export class EventMatchConfig {
  @PrimaryColumn({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'boolean', default: false })
  enabled!: boolean;

  @Column({ type: 'timestamptz' })
  cutoffAt!: Date;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  hostQuestions!: HostQuestion[];

  @Column({ type: 'varchar', length: 200, nullable: true })
  meetingPointNote!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  matchedAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  lateGroupAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  feedbackPromptedAt!: Date | null;

  /** Bumped per solver run so each run has its own seed label. */
  @Column({ type: 'int', default: 0 })
  runCount!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
