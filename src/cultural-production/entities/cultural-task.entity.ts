import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  DEFAULT_CULTURAL_TASK_STATUS,
  type CulturalTaskStatus,
} from '../cultural-production.constants';
import { CulturalGuide } from './cultural-guide.entity';
import { CulturalIdea } from './cultural-idea.entity';

/**
 * Cultural Production: one task staff assign to each other, alone or as part
 * of the batch a guide turns into for an event. A staff-only table.
 *
 * `due_on` and `event_on` are calendar days read in `CULTURAL_TIME_ZONE`,
 * handed back as `YYYY-MM-DD` text. `completed_at` is set exactly when the
 * status is `done`. A deleted idea, guide or account leaves the task with that
 * key null. `IDX_cultural_tasks_status_due_on` serves the open-task sort and
 * the badge. Migration `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_tasks')
@Index('IDX_cultural_tasks_status_due_on', ['status', 'dueOn'])
@Index('IDX_cultural_tasks_idea_id', ['ideaId'], {
  where: '"idea_id" IS NOT NULL',
})
@Index('IDX_cultural_tasks_guide_id', ['guideId'], {
  where: '"guide_id" IS NOT NULL',
})
@Index('IDX_cultural_tasks_author_id', ['authorId'], {
  where: '"author_id" IS NOT NULL',
})
@Check('CHK_cultural_tasks_title', `char_length(btrim("title")) >= 1`)
@Check('CHK_cultural_tasks_notes', `char_length("notes") <= 4000`)
@Check('CHK_cultural_tasks_status', `"status" IN ('todo', 'doing', 'done')`)
@Check(
  'CHK_cultural_tasks_completed',
  `("status" = 'done') = ("completed_at" IS NOT NULL)`,
)
export class CulturalTask {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_cultural_tasks',
  })
  id!: string;

  @Column({ type: 'varchar', length: 160 })
  title!: string;

  @Column({ type: 'text', default: '' })
  notes!: string;

  @Column({
    type: 'varchar',
    length: 16,
    default: DEFAULT_CULTURAL_TASK_STATUS,
  })
  status!: CulturalTaskStatus;

  /** `YYYY-MM-DD`; TypeORM hands a `date` column back as a string. */
  @Column({ type: 'date', nullable: true })
  dueOn!: string | null;

  /** `YYYY-MM-DD`; the event day a guide batch counted back from. */
  @Column({ type: 'date', nullable: true })
  eventOn!: string | null;

  @Column({ type: 'uuid', nullable: true })
  ideaId!: string | null;

  @ManyToOne(() => CulturalIdea, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'idea_id',
    foreignKeyConstraintName: 'FK_cultural_tasks_idea',
  })
  idea?: CulturalIdea | null;

  @Column({ type: 'uuid', nullable: true })
  guideId!: string | null;

  @ManyToOne(() => CulturalGuide, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'guide_id',
    foreignKeyConstraintName: 'FK_cultural_tasks_guide',
  })
  guide?: CulturalGuide | null;

  @Column({ type: 'uuid', nullable: true })
  authorId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'author_id',
    foreignKeyConstraintName: 'FK_cultural_tasks_author',
  })
  author?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  completedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
