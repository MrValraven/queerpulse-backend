import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An immutable record of one moderator action against one report — written
 * on every `PATCH /mod/reports/:id`, `POST /mod/reports/bulk`, and
 * `PATCH /mod/appeals/:id` (uphold/overturn also logs against the appeal's
 * `reportId`, when present).
 */
@Entity('mod_audit_logs')
export class ModAuditLog {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_mod_audit_logs_report_id')
  @Column({ type: 'uuid' })
  reportId: string;

  @Index('IDX_mod_audit_logs_actor_id')
  @Column({ type: 'uuid' })
  actorId: string;

  @Column({ type: 'varchar' })
  action: string;

  // The `ReasonCode` (`../../reports/reason-catalogue.ts`) the moderator
  // cited for this action, when one was given (`ModActionInput.reasonCode`).
  @Column({ type: 'varchar', nullable: true })
  reasonCode: string | null;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  // e.g. "7d" for restrict/suspend (`ModActionInput.duration`).
  @Column({ type: 'varchar', nullable: true })
  duration: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
