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

/**
 * Quiz win badges: one member who won one numbered game of one event, with the
 * screen name and team name they played under. A row with `revoked_at` set is
 * a revoked winner; every other row is a live winner, and only the revoke route
 * writes the three revoke columns, once. Account erasure deletes the member's
 * rows through the cascade, deleting the event or the session sets `event_id`
 * or `session_id` null and keeps the row, and a deleted revoking account leaves
 * `revoked_by_id` null. The winner rows are kept until the member's account
 * erasure. `UQ_quiz_game_winners_session_user` is the recording insert's
 * `ON CONFLICT DO NOTHING` target. The checks `CHK_quiz_game_winners_game_number`
 * and `CHK_quiz_game_winners_revoke` live in the migration only. Migration
 * `1840910000000-AddQuizWinBadges`.
 */
@Entity('quiz_game_winners')
@Index('UQ_quiz_game_winners_session_user', ['sessionId', 'userId'], {
  unique: true,
})
@Index('IDX_quiz_game_winners_event_game', ['eventId', 'gameNumber'])
@Index('IDX_quiz_game_winners_user_id', ['userId'])
@Index('IDX_quiz_game_winners_revoked_by_id', ['revokedById'], {
  where: '"revoked_by_id" IS NOT NULL',
})
export class QuizGameWinner {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_quiz_game_winners',
  })
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @ManyToOne(() => Event, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_quiz_game_winners_event_id',
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
    foreignKeyConstraintName: 'FK_quiz_game_winners_session_id',
  })
  session?: QuizshowSessionRecord | null;

  @Column({ type: 'integer' })
  gameNumber!: number;

  @Column({ type: 'timestamptz', precision: 3 })
  finishedAt!: Date;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_quiz_game_winners_user_id',
  })
  user?: User;

  @Column({ type: 'varchar', length: 30 })
  screenName!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  teamName!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  revokedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'revoked_by_id',
    foreignKeyConstraintName: 'FK_quiz_game_winners_revoked_by_id',
  })
  revokedBy?: User | null;

  @Column({ type: 'varchar', length: 300, nullable: true })
  revokeReason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
