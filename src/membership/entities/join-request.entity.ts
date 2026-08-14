import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum JoinRequestStatus {
  Pending = 'pending',
  Approved = 'approved',
  Declined = 'declined',
}

/**
 * A request to join from someone who has NO account. There is deliberately no
 * `userId` and no relation to `users`: the applicant is a stranger until an
 * admin approves them and the resulting invite is redeemed through Google
 * sign-up. See `PublicJoinRequests1782800730000`.
 */
@Entity('join_requests')
export class JoinRequest {
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
    enum: JoinRequestStatus,
    enumName: 'join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status!: JoinRequestStatus;

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
