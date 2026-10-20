import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { QuizshowAnswerRecord } from './quizshow-answer.entity';
import { QuizshowPlayerRecord } from './quizshow-player.entity';
import { QuizshowSessionRecord } from './quizshow-session.entity';

/**
 * One player's vote on a party question. A null `answerId` is the vote for
 * the truth.
 * Retention: votes are deleted 30 days after the session ends.
 */
@Entity('quizshow_votes')
@Unique('UQ_quizshow_votes_voter_question', ['voterPlayerId', 'questionId'])
@Index('IDX_quizshow_votes_answer_id', ['answerId'])
@Index('IDX_quizshow_votes_session_id', ['sessionId'])
export class QuizshowVoteRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => QuizshowSessionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quizshow_votes_session',
  })
  session?: QuizshowSessionRecord;

  @Column({ type: 'uuid' })
  questionId!: string;

  @Column({ type: 'uuid' })
  voterPlayerId!: string;

  @ManyToOne(() => QuizshowPlayerRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'voter_player_id',
    foreignKeyConstraintName: 'FK_quizshow_votes_voter',
  })
  voter?: QuizshowPlayerRecord;

  @Column({ type: 'uuid', nullable: true })
  answerId!: string | null;

  @ManyToOne(() => QuizshowAnswerRecord, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'answer_id',
    foreignKeyConstraintName: 'FK_quizshow_votes_answer',
  })
  answer?: QuizshowAnswerRecord | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
