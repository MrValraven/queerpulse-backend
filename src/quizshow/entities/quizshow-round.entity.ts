import {
  Column,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import {
  QUIZSHOW_CONTENT_LABELS,
  QUIZSHOW_ROUND_KINDS,
  QuizshowContentLabel,
  QuizshowRoundKind,
  QuizshowRoundSettings,
} from '../quizshow.contract';
import { QuizshowQuizRecord } from './quizshow-quiz.entity';

/**
 * One round of a quiz, ordered by `position` within the quiz.
 * Retention: the round lives with its quiz (FK cascade), so until the event goes.
 */
@Entity('quizshow_rounds')
@Unique('UQ_quizshow_rounds_quiz_position', ['quizId', 'position'])
export class QuizshowRoundRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  quizId!: string;

  @ManyToOne(() => QuizshowQuizRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'quiz_id',
    foreignKeyConstraintName: 'FK_quizshow_rounds_quiz',
  })
  quiz?: QuizshowQuizRecord;

  @Column({ type: 'int' })
  position!: number;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_ROUND_KINDS,
    enumName: 'quizshow_round_kind',
  })
  kind!: QuizshowRoundKind;

  @Column({ type: 'varchar', length: 80 })
  titleEn!: string;

  @Column({ type: 'varchar', length: 80 })
  titlePt!: string;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_CONTENT_LABELS,
    enumName: 'quizshow_content_label',
  })
  contentLabel!: QuizshowContentLabel;

  @Column({ type: 'jsonb' })
  settings!: QuizshowRoundSettings;
}
