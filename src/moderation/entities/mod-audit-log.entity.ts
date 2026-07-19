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

  // Nullable since `AddModerationEnforcement1782800800000`: lifting a
  // suspension (`PATCH /mod/users/:userId/suspension`) is a moderator action
  // that need not be a response to any particular report. A placeholder id
  // would put a fabricated link into an immutable trail.
  //
  // Consequence: a row with a NULL `reportId` appears in no
  // `GET /mod/reports/audit` response, since that endpoint filters by report.
  // There is no global audit feed yet — the lift DTO therefore takes an
  // optional `reportId` so a moderator acting on a specific report can keep
  // the two linked.
  @Index('IDX_mod_audit_logs_report_id')
  @Column({ type: 'uuid', nullable: true })
  reportId: string | null;

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
