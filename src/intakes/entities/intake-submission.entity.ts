import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';
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
 * `kind` and `status` are plain varchars (not Postgres enums) so a new form
 * kind or triage state never needs an enum migration — allowed values are
 * enforced by the allowlist / DTO on the way in. The entity is never returned
 * raw; every read hand-maps through `intakes-response.ts`.
 */
@Entity('intake_submissions')
export class IntakeSubmission {
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
