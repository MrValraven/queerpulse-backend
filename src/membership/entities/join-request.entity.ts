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
  id: string;

  @Column({ type: 'varchar' })
  name: string;

  /**
   * Stored trimmed + lowercased by the service. The open-request uniqueness
   * index (`UQ_join_requests_pending_email`) is on `lower(email)`, so casing
   * can never be used to queue a second open request.
   */
  @Column({ type: 'varchar' })
  email: string;

  @Column({ type: 'varchar', nullable: true })
  city: string | null;

  @Column({ type: 'text' })
  message: string;

  @Column({
    type: 'enum',
    enum: JoinRequestStatus,
    enumName: 'join_requests_status_enum',
    default: JoinRequestStatus.Pending,
  })
  status: JoinRequestStatus;

  /** 18+ self-attestation, mirroring `User.ageAttestedAt` (Terms §eligibility). */
  @Column({ type: 'timestamptz' })
  ageAttestedAt: Date;

  /** Terms revision the attestation was made against, e.g. "2.4". */
  @Column({ type: 'varchar', length: 32 })
  termsVersion: string;

  @Column({ type: 'uuid', nullable: true })
  reviewedBy: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reviewedAt: Date | null;

  /**
   * The invite minted by the approval, bound to `email`. Null while pending and
   * for declined requests. The FK is ON DELETE SET NULL so purging an invite
   * never erases the record that the approval happened.
   */
  @Index()
  @Column({ type: 'uuid', nullable: true })
  inviteId: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
