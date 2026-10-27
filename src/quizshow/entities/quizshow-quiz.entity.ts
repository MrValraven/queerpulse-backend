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
import { QuizshowTemplateRecord } from './quizshow-template.entity';
import {
  QUIZSHOW_LANGUAGE_MODES,
  QUIZSHOW_LANGUAGES,
  QuizshowLanguage,
  QuizshowLanguageMode,
} from '../quizshow.contract';

/**
 * The quiz of an event, a game owned by a member, or a staff template, for
 * Pulse Live: exactly one of `eventId`, `ownerUserId` and `templateId` is set.
 * An event has one quiz and a template has one quiz.
 * Retention: the quiz lives until its event goes (FK cascade), until its
 * owner's account goes (FK cascade), or until its template is deleted (FK
 * cascade). `sourceTemplateId` records the template a copy came from and is
 * set null when that template is deleted. Author columns are set null when an
 * account goes. `updatedAt` is a plain column the
 * service sets, so the new value is returned as `updatedAt` before commit.
 */
@Entity('quizshow_quizzes')
@Unique('UQ_quizshow_quizzes_event_id', ['eventId'])
@Unique('UQ_quizshow_quizzes_template_id', ['templateId'])
@Check(
  'CHK_quizshow_quizzes_scope',
  'num_nonnulls("event_id", "owner_user_id", "template_id") = 1',
)
@Index('IDX_quizshow_quizzes_owner_user_id', ['ownerUserId'])
@Index('IDX_quizshow_quizzes_source_template_id', ['sourceTemplateId'])
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

  @Column({ type: 'uuid', nullable: true })
  templateId!: string | null;

  @ManyToOne(() => QuizshowTemplateRecord, {
    onDelete: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'template_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_template',
  })
  template?: QuizshowTemplateRecord | null;

  @Column({ type: 'uuid', nullable: true })
  sourceTemplateId!: string | null;

  @ManyToOne(() => QuizshowTemplateRecord, {
    onDelete: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'source_template_id',
    foreignKeyConstraintName: 'FK_quizshow_quizzes_source_template',
  })
  sourceTemplate?: QuizshowTemplateRecord | null;

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
