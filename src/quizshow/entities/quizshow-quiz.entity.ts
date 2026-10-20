import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';
import {
  QUIZSHOW_LANGUAGE_MODES,
  QUIZSHOW_LANGUAGES,
  QuizshowLanguage,
  QuizshowLanguageMode,
} from '../quizshow.contract';

/**
 * The quiz of an event, or a game owned by a member, for Pulse Live: exactly
 * one of `eventId` and `ownerUserId` is set. An event has one quiz.
 * Retention: the quiz lives until its event goes (FK cascade), or until its
 * owner's account goes (FK cascade). Author columns are set null when an
 * account goes. `updatedAt` is a plain column the
 * service sets, so the new value is returned as `updatedAt` before commit.
 */
@Entity('quizshow_quizzes')
@Unique('UQ_quizshow_quizzes_event_id', ['eventId'])
@Check(
  'CHK_quizshow_quizzes_scope',
  'num_nonnulls("event_id", "owner_user_id") = 1',
)
@Index('IDX_quizshow_quizzes_owner_user_id', ['ownerUserId'])
export class QuizshowQuizRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @ManyToOne(() => Event, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_event',
  })
  event?: Event | null;

  @Column({ type: 'uuid', nullable: true })
  ownerUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'owner_user_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_owner',
  })
  owner?: User | null;

  @Column({ type: 'boolean', default: false })
  isAdultsOnly!: boolean;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_LANGUAGE_MODES,
    enumName: 'quizshow_language_mode',
  })
  languages!: QuizshowLanguageMode;

  @Column({
    type: 'enum',
    enum: QUIZSHOW_LANGUAGES,
    enumName: 'quizshow_language',
  })
  screenLanguage!: QuizshowLanguage;

  @Column({ type: 'varchar', length: 40, nullable: true })
  starterPackKey!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_created_by',
  })
  createdBy?: User | null;

  @Column({ type: 'uuid', nullable: true })
  updatedByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'updated_by_user_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_updated_by',
  })
  updatedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
