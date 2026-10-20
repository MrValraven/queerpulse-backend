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
import { QuizshowSessionRecord } from './quizshow-session.entity';
import { QuizshowTeamRecord } from './quizshow-team.entity';

/**
 * A member playing in one session. Wire frames carry only `playerId` and omit the
 * user id.
 * Retention: players are kept while the session's `resultsKept` is true; the
 * user FK cascades on account erasure.
 */
@Entity('quizshow_players')
@Unique('UQ_quizshow_players_session_user', ['sessionId', 'userId'])
export class QuizshowPlayerRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => QuizshowSessionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quizshow_players_session',
  })
  session?: QuizshowSessionRecord;

  @Index('IDX_quizshow_players_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_quizshow_players_user',
  })
  user?: User;

  @Column({ type: 'boolean' })
  isCohostPlayer!: boolean;

  @Column({ type: 'uuid', nullable: true })
  teamId!: string | null;

  @ManyToOne(() => QuizshowTeamRecord, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'team_id',
    foreignKeyConstraintName: 'FK_quizshow_players_team',
  })
  team?: QuizshowTeamRecord | null;

  @Column({ type: 'varchar', length: 30 })
  screenName!: string;

  @Column({ type: 'boolean', default: false })
  isAvatarShown!: boolean;

  @Column({ type: 'boolean', default: false })
  hasExtraTime!: boolean;

  @Column({ type: 'int', default: 0 })
  score!: number;

  @Column({ type: 'int', default: 0 })
  streak!: number;

  @Column({ type: 'boolean', default: false })
  hasUsedJoker!: boolean;

  @Column({ type: 'int', nullable: true })
  jokerRoundIndex!: number | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  removedAt!: Date | null;

  @Column({ type: 'timestamptz', precision: 3 })
  joinedAt!: Date;
}
