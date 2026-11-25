import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Event } from '../../events/entities/event.entity';
import { QuizshowSessionRecord } from '../../quizshow/entities/quizshow-session.entity';
import { User } from '../../users/entities/user.entity';
import { QuizBadgeDefinition } from './quiz-badge-definition.entity';

/**
 * Quiz win badges: one badge won by one member in one numbered game. The row
 * keeps the event name and the event's public and 18+ state as they were when
 * the win was written, so the member's own badge page can still name the event
 * after it is renamed or deleted. Account erasure deletes the member's rows
 * through the cascade, deleting the event or the session sets `event_id` or
 * `session_id` null and keeps the row, and a definition with wins cannot be
 * deleted (`ON DELETE RESTRICT`). The wins are kept until the member's account
 * erasure. `UQ_quiz_badge_wins_session_badge_user` is the idempotency target of
 * the awarding insert. Migration `1840910000000-AddQuizWinBadges`.
 */
@Entity('quiz_badge_wins')
@Index(
  'UQ_quiz_badge_wins_session_badge_user',
  ['sessionId', 'badgeDefinitionId', 'userId'],
  { unique: true },
)
@Index('IDX_quiz_badge_wins_user_badge', ['userId', 'badgeDefinitionId'])
@Index('IDX_quiz_badge_wins_badge_definition_id', ['badgeDefinitionId'])
@Index('IDX_quiz_badge_wins_event_id', ['eventId'], {
  where: '"event_id" IS NOT NULL',
})
export class QuizBadgeWin {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_quiz_badge_wins',
  })
  id!: string;

  @Column({ type: 'uuid' })
  badgeDefinitionId!: string;

  @ManyToOne(() => QuizBadgeDefinition, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'badge_definition_id',
    foreignKeyConstraintName: 'FK_quiz_badge_wins_badge_definition_id',
  })
  badgeDefinition?: QuizBadgeDefinition;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_quiz_badge_wins_user_id',
  })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @ManyToOne(() => Event, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_quiz_badge_wins_event_id',
  })
  event?: Event | null;

  @Column({ type: 'uuid', nullable: true })
  sessionId!: string | null;

  @ManyToOne(() => QuizshowSessionRecord, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quiz_badge_wins_session_id',
  })
  session?: QuizshowSessionRecord | null;

  @Column({ type: 'integer' })
  gameNumber!: number;

  @Column({ type: 'text' })
  eventNameSnapshot!: string;

  @Column({ type: 'boolean' })
  eventWasPublic!: boolean;

  @Column({ type: 'boolean' })
  eventWasAdultsOnly!: boolean;

  @Column({ type: 'timestamptz', precision: 3 })
  wonAt!: Date;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
