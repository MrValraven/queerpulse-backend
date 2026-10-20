import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';
import {
  QUIZSHOW_PLAY_MODES,
  QUIZSHOW_SESSION_STATUSES,
  QuizshowCursor,
  QuizshowPlayMode,
  QuizshowSessionStatus,
} from '../quizshow.contract';
import { QuizshowQuizRecord } from './quizshow-quiz.entity';

/**
 * The stored form of the live cursor. The status lives in its own column and
 * `phaseId` is `String(phaseCounter)`.
 */
export type QuizshowStoredCursor = Omit<
  QuizshowCursor,
  'status' | 'phaseId'
> & { phaseCounter: number };

/**
 * One live game of a quiz. The join code, the event and the quiz are each held
 * by at most one open session (lobby, running or paused). A game owned by a
 * member has no event.
 * Retention: the session row lives with its quiz (FK cascade), so it follows
 * the event or the owner. Its answers
 * and votes are deleted 30 days after the session ends; players and teams
 * stay while `resultsKept` is true.
 */
@Entity('quizshow_sessions')
@Index('UQ_quizshow_sessions_open_join_code', ['joinCode'], {
  unique: true,
  where: `"status" IN ('lobby','running','paused')`,
})
@Index('UQ_quizshow_sessions_open_event', ['eventId'], {
  unique: true,
  where: `"status" IN ('lobby','running','paused')`,
})
@Index('UQ_quizshow_sessions_open_quiz', ['quizId'], {
  unique: true,
  where: `"status" IN ('lobby','running','paused')`,
})
@Index('IDX_quizshow_sessions_started_by_started_at', [
  'startedByUserId',
  'startedAt',
])
// The migration 1836000100000-AddQuizshow.ts is authoritative: it creates this index with started_at DESC, which TypeORM index metadata cannot express, so never regenerate it from the entity.
@Index('IDX_quizshow_sessions_join_code_started_at', ['joinCode', 'startedAt'])
@Index('IDX_quizshow_sessions_status_ended_at', ['status', 'endedAt'])
@Index('IDX_quizshow_sessions_event_id', ['eventId'])
@Index('IDX_quizshow_sessions_quiz_id', ['quizId'])
export class QuizshowSessionRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  quizId!: string;

  @ManyToOne(() => QuizshowQuizRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'quiz_id',
    foreignKeyConstraintName: 'FK_quizshow_sessions_quiz',
  })
  quiz?: QuizshowQuizRecord;

  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @ManyToOne(() => Event, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_quizshow_sessions_event',
  })
  event?: Event | null;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_SESSION_STATUSES,
    enumName: 'quizshow_session_status',
  })
  status!: QuizshowSessionStatus;

  @Column({ type: 'char', length: 6 })
  joinCode!: string;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_PLAY_MODES,
    enumName: 'quizshow_play_mode',
  })
  playMode!: QuizshowPlayMode;

  @Column({ type: 'int', nullable: true })
  maxTeamSize!: number | null;

  @Column({ type: 'boolean', default: true })
  isReviewOn!: boolean;

  @Column({ type: 'jsonb' })
  cursor!: QuizshowStoredCursor;

  /** Task 25 reads it as `QuizshowQuestionLogEntry[]`. */
  @Column({ type: 'jsonb', default: () => `'[]'` })
  questionLog!: unknown[];

  /** Holds the `QuizshowSessionSnapshot` frozen at open; typed `unknown` to keep this file import-light. */
  @Column({ type: 'jsonb' })
  quizSnapshot!: unknown;

  @Column({ type: 'uuid', nullable: true })
  startedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'started_by_user_id',
    foreignKeyConstraintName: 'FK_quizshow_sessions_started_by',
  })
  startedBy?: User | null;

  @Column({ type: 'timestamptz', precision: 3 })
  startedAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  endedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3 })
  lastHostCommandAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  pausedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  guestPushSentAt!: Date | null;

  @Column({ type: 'boolean', default: true })
  resultsKept!: boolean;

  @Column({ type: 'uuid', array: true, default: () => `'{}'` })
  attachedOrganiserUserIds!: string[];
}
