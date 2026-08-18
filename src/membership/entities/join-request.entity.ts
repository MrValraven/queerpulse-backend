/**
 * PLATFORM-LEVEL join request: a stranger with no account asking to join
 * QueerPulse itself, reviewed by the mod queue and (on approval) turned into
 * an invite. Do not confuse this with the COMMUNITY-LEVEL join request in
 * `src/communities/entities/community-join-request.entity.ts`
 * (`CommunityJoinRequest`), which is an existing member asking to join one
 * gated community. Named `PlatformJoinRequest`/`PlatformJoinRequestStatus`
 * (rather than the bare `JoinRequest`/`JoinRequestStatus` this module used to
 * export) precisely so the two can never collide if some future file needs
 * both. Otherwise unrelated: different tables (`join_requests` vs
 * `community_join_requests`), different controllers/services, no shared code.
 */
import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum PlatformJoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
  Waitlisted = 'waitlisted',
}

/**
 * A request to join from someone who has NO account. There is deliberately no
 * `userId` and no relation to `users`: the applicant is a stranger until an
 * admin approves them and the resulting invite is redeemed through Google
 * sign-up. See `PublicJoinRequests1782800730000`.
 */
@Entity('join_requests')
export class PlatformJoinRequest {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  name!: string;

  /**
   * Stored trimmed + lowercased by the service. The open-request uniqueness
   * index (`UQ_join_requests_pending_email`) is on `lower(email)`, so casing
   * can never be used to queue a second open request.
   */
  @Column({ type: 'varchar' })
  email!: string;

  @Column({ type: 'varchar', nullable: true })
  city!: string | null;

  @Column({ type: 'text' })
  message!: string;

  /**
   * The email of a member already here who can vouch for the applicant, as a
   * structured, matchable field — previously this was only ever prose folded
   * into `message`, which meant a reviewer had to read the whole message to
   * find it and nothing could match it against a real member. Nullable: most
   * applicants have nobody to name.
   */
  @Column({ type: 'varchar', length: 254, nullable: true })
  mutualMemberEmail!: string | null;

  /**
   * Set only when `mutualMemberEmail` matched an ACTIVE member at submit
   * time. Null when no reference was supplied, or when the supplied email
   * didn't match anyone active. ON DELETE SET NULL: the reference is
   * corroborating context, not something worth blocking a user deletion
   * over.
   */
  @Index('IDX_join_requests_reference_user_id')
  @Column({ type: 'uuid', nullable: true })
  referenceUserId!: string | null;

  /**
   * Which frontend entry point the applicant came through — the CTA that sent
   * them to the invite request form (e.g. `homepage_hero`, `skills`,
   * `sign_in`). A stable key owned by the frontend catalogue, not a URL, so the
   * admin queue can show "came from …" without the backend knowing the route
   * map. Nullable: legacy rows predate the column, and someone who opens the
   * request page directly has no originating CTA.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  source!: string | null;

  @Column({
    type: 'enum',
    enum: PlatformJoinRequestStatus,
    enumName: 'join_requests_status_enum',
    default: PlatformJoinRequestStatus.Pending,
  })
  status!: PlatformJoinRequestStatus;

  /** 18+ self-attestation, mirroring `User.ageAttestedAt` (Terms §eligibility). */
  @Column({ type: 'timestamptz' })
  ageAttestedAt!: Date;

  /** Terms revision the attestation was made against, e.g. "2.4". */
  @Column({ type: 'varchar', length: 32 })
  termsVersion!: string;

  @Index('IDX_join_requests_reviewed_by')
  @Column({ type: 'uuid', nullable: true })
  reviewedBy!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt!: Date | null;

  /**
   * Closed-set reason key the reviewer picked when declining (e.g.
   * `spam_pattern`, `underage`, `implausible`, `safety_concern`, `other`). The
   * catalogue lives on the frontend (mirrors `source`); this column is
   * length-capped, not enum-validated, so the set can grow without a backend
   * deploy. Null for approvals, waitlists, and legacy declines that predate
   * this column.
   */
  @Column({ type: 'varchar', length: 64, nullable: true })
  declineReason!: string | null;

  /**
   * The invite minted by the approval, bound to `email`. Null while pending and
   * for declined requests. The FK is ON DELETE SET NULL so purging an invite
   * never erases the record that the approval happened.
   */
  @Index('IDX_join_requests_invite_id')
  @Column({ type: 'uuid', nullable: true })
  inviteId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
