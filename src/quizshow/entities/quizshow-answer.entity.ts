import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { QuizshowAnswerPayload } from '../quizshow.contract';
import { QuizshowPlayerRecord } from './quizshow-player.entity';
import { QuizshowSessionRecord } from './quizshow-session.entity';

/**
 * One player's answer to one question. `questionId` is the id inside the
 * session snapshot, so it has no foreign key.
 * Retention: answers are deleted 30 days after the session ends.
 */
@Entity('quizshow_answers')
@Unique('UQ_quizshow_answers_player_question', ['playerId', 'questionId'])
@Index('IDX_quizshow_answers_session_question', ['sessionId', 'questionId'])
export class QuizshowAnswerRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => QuizshowSessionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quizshow_answers_session',
  })
  session?: QuizshowSessionRecord;

  @Column({ type: 'uuid' })
  questionId!: string;

  @Column({ type: 'uuid' })
  playerId!: string;

  @ManyToOne(() => QuizshowPlayerRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'player_id',
    foreignKeyConstraintName: 'FK_quizshow_answers_player',
  })
  player?: QuizshowPlayerRecord;

  @Column({ type: 'jsonb' })
  payload!: QuizshowAnswerPayload;

  @Column({ type: 'timestamptz', precision: 3 })
  receivedAt!: Date;

  @Column({ type: 'int', nullable: true })
  elapsedMs!: number | null;

  @Column({ type: 'boolean', nullable: true })
  isCorrect!: boolean | null;

  @Column({ type: 'int', default: 0 })
  pointsAwarded!: number;

  @Column({ type: 'uuid', nullable: true })
  voteOptionId!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  hiddenAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  hiddenByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'hidden_by_user_id',
    foreignKeyConstraintName: 'FK_quizshow_answers_hidden_by',
  })
  hiddenBy?: User | null;
}
