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
  id!: string;

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
  reportId!: string | null;

  // Nullable since `AddDeletionErasureSupport1782800700000`: NULLed when the
  // acting moderator erases their account (FK is `ON DELETE SET NULL`), so the
  // action trail survives the person who wrote it. An immutable log that
  // disappears when its author leaves is not an immutable log. Always non-null
  // at write time; only erasure produces a NULL.
  @Index('IDX_mod_audit_logs_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'varchar' })
  action!: string;

  // The member a role-management action (`role_changed`, `staff_role_granted`,
  // `staff_role_revoked`) was taken against — `AdminMembersService.updateRole`/
  // `grantStaffRole`/`revokeStaffRole` are the only writers. Nullable because
  // every other action logs against a `reportId` instead (or, for
  // `suspension_lifted`, neither): a row without a report is not automatically
  // about a member. `ON DELETE SET NULL` mirrors `actorId` — an audit row
  // outlives the account it names when that account is erased.
  @Index('IDX_mod_audit_logs_target_user_id')
  @Column({ type: 'uuid', nullable: true })
  targetUserId!: string | null;

  // Denormalized snapshot of the target member's display name at the moment
  // of the action (`firstName lastName`, the same shape `nameForUserId`
  // resolves). Written alongside `targetUserId` by the same three call sites
  // so the audit trail can still say who was promoted/granted/revoked after
  // the member is erased (`targetUserId` → NULL) or later changes their name
  // — immutable once written, like `note`. This is what `subjectFor()`
  // (`mod-audit.service.ts`) renders instead of the generic "Platform action"
  // fallback for these row types.
  @Column({ type: 'varchar', nullable: true })
  targetName!: string | null;

  // The `ReasonCode` (`../../reports/reason-catalogue.ts`) the moderator
  // cited for this action, when one was given (`ModActionInput.reasonCode`).
  @Column({ type: 'varchar', nullable: true })
  reasonCode!: string | null;

  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // e.g. "7d" for restrict/suspend (`ModActionInput.duration`).
  @Column({ type: 'varchar', nullable: true })
  duration!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
