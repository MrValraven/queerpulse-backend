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
import { Lead } from './lead.entity';

/**
 * Leads: one row per lead and staff member in charge of it. A staff-only
 * table: it stays on the `admin/leads` routes and never reaches a member
 * surface. A deleted account or lead takes its rows through the cascade; a
 * deleted assigner leaves `assigned_by_id` null. The primary key
 * `(lead_id, user_id)` serves every per-lead read, `IDX_lead_assignees_user_id`
 * serves the per-person reads, and `IDX_lead_assignees_assigned_by_id` backs
 * the assigner key. Migration `1840300000000-AddLeadAssignees`.
 */
@Entity('lead_assignees')
@Index('IDX_lead_assignees_user_id', ['userId'])
@Index('IDX_lead_assignees_assigned_by_id', ['assignedById'], {
  where: '"assigned_by_id" IS NOT NULL',
})
export class LeadAssignee {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_lead_assignees',
  })
  leadId!: string;

  @ManyToOne(() => Lead, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'lead_id',
    foreignKeyConstraintName: 'FK_lead_assignees_lead',
  })
  lead?: Lead;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_lead_assignees',
  })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_lead_assignees_user',
  })
  user?: User;

  @Column({ type: 'uuid', nullable: true })
  assignedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'assigned_by_id',
    foreignKeyConstraintName: 'FK_lead_assignees_assigned_by',
  })
  assignedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  assignedAt!: Date;
}
