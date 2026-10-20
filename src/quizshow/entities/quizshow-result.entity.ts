import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
} from 'typeorm';
import { QuizshowRecap } from '../quizshow.contract';
import { QuizshowSessionRecord } from './quizshow-session.entity';

/** One podium row as stored; the entrant is a player or a team id. */
export interface QuizshowStoredPodiumEntry {
  place: 1 | 2 | 3;
  kind: 'player' | 'team';
  entrantId: string;
  score: number;
}

/**
 * The finished session's results card: podium, placings and per-question
 * recap. Retention: kept while the session's `resultsKept` is true; the
 * session FK cascades.
 */
@Entity('quizshow_results')
export class QuizshowResultRecord {
  @PrimaryColumn({ type: 'uuid' })
  sessionId!: string;

  @OneToOne(() => QuizshowSessionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quizshow_results_session',
  })
  session?: QuizshowSessionRecord;

  @Column({ type: 'jsonb' })
  podium!: QuizshowStoredPodiumEntry[];

  /** Player id to place. */
  @Column({ type: 'jsonb' })
  placings!: Record<string, number>;

  @Column({ type: 'jsonb' })
  questionStats!: QuizshowRecap;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
