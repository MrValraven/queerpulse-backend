import {
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import {
  QUIZSHOW_TEAM_COLOR_KEYS,
  QuizshowTeamColorKey,
} from '../quizshow.contract';
import { QuizshowSessionRecord } from './quizshow-session.entity';

/**
 * A team in a teams-mode session, one per colour key.
 * Team names are unique per session ignoring case through the unique index
 * `UQ_quizshow_teams_session_name` on (`session_id`, `lower(name)`). TypeORM
 * cannot express an expression index, so the migration alone creates it.
 * Retention: teams are kept while the session's `resultsKept` is true.
 */
@Entity('quizshow_teams')
@Unique('UQ_quizshow_teams_session_color', ['sessionId', 'colorKey'])
export class QuizshowTeamRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  sessionId!: string;

  @ManyToOne(() => QuizshowSessionRecord, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'session_id',
    foreignKeyConstraintName: 'FK_quizshow_teams_session',
  })
  session?: QuizshowSessionRecord;

  @Column({ type: 'varchar', length: 40 })
  name!: string;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_TEAM_COLOR_KEYS,
    enumName: 'quizshow_team_color_key',
  })
  colorKey!: QuizshowTeamColorKey;

  @Column({ type: 'int', default: 0 })
  score!: number;

  @Column({ type: 'boolean', default: false })
  hasUsedJoker!: boolean;

  @Column({ type: 'int', nullable: true })
  jokerRoundIndex!: number | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
