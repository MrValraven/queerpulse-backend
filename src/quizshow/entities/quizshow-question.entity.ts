import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import {
  QUIZSHOW_QUESTION_TYPES,
  QuizshowOption,
  QuizshowQuestionType,
} from '../quizshow.contract';
import { QuizshowRoundRecord } from './quizshow-round.entity';

/**
 * One question of a round, ordered by `position` within the round.
 * `options`, `answer` and `acceptedAnswers` hold the shapes the contract gives
 * each question type. Retention: the question lives with its quiz (FK cascade),
 * so until the event goes.
 */
@Entity('quizshow_questions')
@Unique('UQ_quizshow_questions_round_position', ['roundId', 'position'])
export class QuizshowQuestionRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  roundId!: string;

  @ManyToOne(() => QuizshowRoundRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'round_id',
    foreignKeyConstraintName: 'FK_quizshow_questions_round',
  })
  round?: QuizshowRoundRecord;

  @Column({ type: 'int' })
  position!: number;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_QUESTION_TYPES,
    enumName: 'quizshow_question_type',
  })
  type!: QuizshowQuestionType;

  @Column({ type: 'varchar', length: 280 })
  promptEn!: string;

  @Column({ type: 'varchar', length: 280 })
  promptPt!: string;

  @Column({ type: 'varchar', length: 512, nullable: true })
  mediaRef!: string | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  options!: QuizshowOption[];

  @Column({ type: 'jsonb', nullable: true })
  answer!: Record<string, unknown> | null;

  @Column({ type: 'jsonb', default: () => `'[]'` })
  acceptedAnswers!: string[];

  @Column({ type: 'int', nullable: true })
  timeLimitSeconds!: number | null;

  @Column({ type: 'int', default: 1000 })
  points!: number;
}
