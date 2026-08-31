import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Lifecycle of an escalation. `open` is where every one starts and is the only
 * state that blocks a second escalation for the same join request; `resolved`
 * is platform staff having looked and said what they found.
 */
export enum BanEvasionEscalationStatus {
  Open = 'open',
  Resolved = 'resolved',
}

/**
 * A community moderator asking platform staff to check whether a join-request
 * applicant is someone returning after a ban.
 *
 * WHY THIS TABLE EXISTS. A community's own owner, co-owners and moderators see
 * one bit about an applicant: does this person match somebody THIS community
 * banned (`community-ban-evasion.service.ts`). They see no score, no matched
 * signal, no hash, and nothing at all about any other community or about a
 * platform-level ban. When their own read of the applicant says "there is more
 * to this than my one bit can tell me", this row is how they hand the question
 * to the people who can see the whole picture. The full cross-community
 * assessment already lives on the staff console (`/admin/ban-evasion`), and an
 * escalation puts the case on that same console rather than opening an inbox of
 * its own.
 *
 * ONE OPEN ESCALATION PER (community, join request), enforced by the partial
 * unique index `UQ_ban_evasion_escalations_open` (`WHERE status = 'open'`), the
 * precedent set by `UQ_reports_open_reporter_subject` and
 * `UQ_community_owner_review_requests_open`. A moderator pressing the button
 * twice, or two moderators of the same community pressing it at once, gets the
 * existing escalation back. Once staff resolve it the community may escalate
 * again, because a second look after a resolution is worth having.
 *
 * ERASURE POSTURE. The two actor references (`raisedByUserId`,
 * `resolvedByUserId`) are `ON DELETE SET NULL`, the actor-FK convention this
 * codebase follows: a moderator leaving the platform must not delete the case
 * they raised. `subjectUserId` is `SET NULL` too, so a resolved case stays
 * readable as history. `communityId` and `joinRequestId` CASCADE, because a
 * deleted community or a deleted join request leaves nothing to adjudicate.
 *
 * Paired migration `1795860000000-CreateBanEvasionEscalations`.
 */
@Entity('ban_evasion_escalations')
@Index('UQ_ban_evasion_escalations_open', ['communityId', 'joinRequestId'], {
  unique: true,
  where: `"status" = 'open'`,
})
export class BanEvasionEscalation {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  /** The community whose moderator raised this. CASCADE. */
  @Index('IDX_ban_evasion_escalations_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  /**
   * The `community_join_requests` row being asked about. CASCADE: an escalation
   * about a join request that no longer exists has nothing to point at.
   */
  @Index('IDX_ban_evasion_escalations_join_request_id')
  @Column({ type: 'uuid' })
  joinRequestId!: string;

  /**
   * The applicant. Denormalized off the join request so the staff console can
   * assess them without a join back through a row that may have been resolved
   * in the meantime. `ON DELETE SET NULL`.
   */
  @Column({ type: 'uuid', nullable: true })
  subjectUserId!: string | null;

  /** The community moderator who escalated. `ON DELETE SET NULL`. */
  @Column({ type: 'uuid', nullable: true })
  raisedByUserId!: string | null;

  /**
   * What the moderator wanted staff to know, in their own words. Optional: the
   * escalation is meaningful without it. Stored as plain text, stripped at this
   * write boundary, never rich text.
   */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  @Column({
    type: 'enum',
    enum: BanEvasionEscalationStatus,
    enumName: 'ban_evasion_escalations_status_enum',
    default: BanEvasionEscalationStatus.Open,
  })
  status!: BanEvasionEscalationStatus;

  /** The staff member who closed it. `ON DELETE SET NULL`. */
  @Column({ type: 'uuid', nullable: true })
  resolvedByUserId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  resolvedAt!: Date | null;

  /**
   * What staff found, for the record. Never sent to the applicant, and never
   * returned on the community-scoped surface: the escalating moderator learns
   * the outcome through whatever staff decide to do, which keeps the one-bit
   * boundary this whole feature rests on intact.
   */
  @Column({ type: 'text', nullable: true })
  resolutionNote!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
