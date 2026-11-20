import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { CulturalTask } from './cultural-task.entity';

/**
 * Cultural Production: one row per task and staff member in charge of it. A
 * staff-only table: it stays on the `admin/cultural-production` routes and
 * never reaches a member surface. A deleted account or task takes its rows
 * through the cascade; a deleted assigner leaves `assigned_by_id` null. The
 * primary key `(task_id, user_id)` serves every per-task read,
 * `IDX_cultural_task_assignees_user_id` serves "Assigned to me", the badge and
 * the access-loss delete, and `IDX_cultural_task_assignees_assigned_by_id`
 * backs the assigner key. Migration `1840600000000-AddCulturalProduction`.
 */
@Entity('cultural_task_assignees')
@Index('IDX_cultural_task_assignees_user_id', ['userId'])
@Index('IDX_cultural_task_assignees_assigned_by_id', ['assignedById'], {
  where: '"assigned_by_id" IS NOT NULL',
})
export class CulturalTaskAssignee {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_cultural_task_assignees',
  })
  taskId!: string;

  @ManyToOne(() => CulturalTask, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'task_id',
    foreignKeyConstraintName: 'FK_cultural_task_assignees_task',
  })
  task?: CulturalTask;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_cultural_task_assignees',
  })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_cultural_task_assignees_user',
  })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  assignedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'assigned_by_id',
    foreignKeyConstraintName: 'FK_cultural_task_assignees_assigned_by',
  })
  assignedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;
}
