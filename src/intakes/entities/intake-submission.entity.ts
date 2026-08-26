import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { QueueAssignmentColumns } from '../../common/queue-assignment.columns';
import type { IntakeKind, IntakeStatus } from '../intake-kinds';

/**
 * A single submission through one of the generic intake forms (grant
 * applications, glossary edit suggestions, sober-host signups, panel signups,
 * the three incubator forms). One table backs every form: `kind` says which
 * form produced the row and `payload` (jsonb) carries that form's fields
 * verbatim — the shapes differ per kind and none of them is queried
 * field-by-field, so a free-form document beats a wide, mostly-null column set.
 *
 * `submitterId` is the signed-in member who sent it, when there was one:
 * public forms (resources) accept anonymous submissions (null), while the
 * member-only incubator forms always carry it. It is a nullable FK →
 * `users(id)` with `ON DELETE SET NULL` (added in the migration, which owns the
 * schema) so erasing a member never deletes the ops record of their submission,
 * it just de-links it.
 *
 * `reviewedById` / `reviewedAt` record who triaged the row and when, for every
 * kind — the eleven non-governance forms flip to a plain `reviewed`, the
 * governance concern walks the richer `reviewing`/`resolved`/`dismissed`
 * worklist, and both stamp the same two columns.
 *
 * `kind` and `status` are plain varchars (not Postgres enums) so a new form
 * kind or triage state never needs an enum migration — allowed values are
 * enforced by the allowlist / DTO on the way in. The entity is never returned
 * raw; every read hand-maps through `intakes-response.ts`.
 */
// Extends `QueueAssignmentColumns` (OPS-04) so an intake can be claimed and
// carries a due date, like every other staff queue. No `@Index` on
// `assigned_staff_id`: the intake console lists by kind/status with no
// assignee filter today, and OPS-04 adds no unused index.
@Entity('intake_submissions')
export class IntakeSubmission extends QueueAssignmentColumns {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_intake_submissions_kind')
  @Column({ type: 'varchar' })
  kind!: IntakeKind;

  @Index('IDX_intake_submissions_submitter_id')
  @Column({ type: 'uuid', nullable: true })
  submitterId!: string | null;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Index('IDX_intake_submissions_status')
  @Column({ type: 'varchar', default: 'new' })
  status!: IntakeStatus;

  /**
   * The admin who last moved this submission out of `new`; null while it is
   * still untouched. Nullable FK → `users(id)` with `ON DELETE SET NULL` (the
   * migration owns the schema), so erasing a staff account de-links the triage
   * record instead of deleting the submission. A plain uuid column with no
   * `@ManyToOne`, exactly like `submitterId` — the reviewer's display name is
   * resolved through the same batched `MemberLookup`, so a list read never
   * joins.
   */
  @Index('IDX_intake_submissions_reviewed_by_id')
  @Column({ type: 'uuid', nullable: true })
  reviewedById!: string | null;

  /** When it was last moved out of `new`; null while it is still untouched. */
  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
