import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** What the audit row is about. */
export type SafeSpaceAuditSubjectType = 'nomination' | 'flag' | 'badge';

/**
 * Every act in the safe-space review process, in one append-only trail.
 *
 * The item this closes asked for exactly this: "every decision is audited: who,
 * when, why". A badge whose only provenance is a tier somebody typed is the
 * problem being fixed, so an award that cannot be traced back to a named
 * moderator, a timestamp and a reason is not an improvement on it.
 *
 * Polymorphic `(subjectType, subjectId)` keying, matching `ContentModeration`
 * and `Report`: one trail a moderator can read end to end for a place, rather
 * than three tables to reassemble. `listingId` is denormalized onto the row so
 * "show me everything ever done to this business's badge" is one indexed query
 * even when the act was against a nomination that only later resolved to it.
 *
 * `actorId` is nullable with no FK, mirroring `mod_audit_logs.actor_id`: a
 * snapshot identity reference, and a null means either the account was erased
 * or the platform itself acted (a threshold suspension, a scheduled sweep).
 *
 * NOTHING HERE IS MEMBER-FACING. `metadata` may carry a flagger's id, so this
 * table is read only through the moderator-guarded audit endpoint.
 */
@Entity('safe_space_decision_audits')
// Composite `@Index()` on the polymorphic key, declared at class level because
// the property-level decorator takes options only, never a column list (the
// same caveat `ListingCoManager` documents).
@Index('IDX_safe_space_decision_audits_subject', ['subjectType', 'subjectId'])
export class SafeSpaceDecisionAudit {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 20 })
  subjectType!: SafeSpaceAuditSubjectType;

  @Column({ type: 'uuid' })
  subjectId!: string;

  /** The listing the act concerned, when one was known at the time. */
  @Index('IDX_safe_space_decision_audits_listing_id')
  @Column({ type: 'uuid', nullable: true })
  listingId!: string | null;

  /**
   * The act, in past tense, as a stable code the admin console renders:
   * `nomination_acknowledged`, `nomination_assigned`, `nomination_awarded`,
   * `nomination_declined`, `nomination_reopened`, `flag_raised`,
   * `flag_withdrawn`, `flag_resolved`, `badge_suspended`, `badge_restored`,
   * `re_review_due`.
   */
  @Column({ type: 'varchar', length: 40 })
  action!: string;

  /** Null when the platform acted rather than a person. */
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  /** Whatever the act needs on the record: the visit count a badge was awarded
   * against, the tier, the flag count that crossed the threshold. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  metadata!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
