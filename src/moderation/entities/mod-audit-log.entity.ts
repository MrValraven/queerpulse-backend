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

  // Nullable since `AddDeletionErasureSupport1782800700000`: NULLed when the
  // acting moderator erases their account (FK is `ON DELETE SET NULL`), so the
  // action trail survives the person who wrote it. An immutable log that
  // disappears when its author leaves is not an immutable log. Always non-null
  // at write time; only erasure produces a NULL.
  @Index('IDX_mod_audit_logs_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId: string | null;

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
