import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// The card's OWN status. The status a verifier sees is this combined with the
// issuing community's freeze/archive state and the expiry clock: see
// `card-status.ts`.
export enum MembershipCardStatus {
  Active = 'active',
  Suspended = 'suspended',
  Revoked = 'revoked',
}

@Entity('membership_cards')
@Unique('UQ_membership_cards_program_user', ['programId', 'userId'])
// Covers the "my cards" read: WHERE user_id = ... ORDER BY issued_at DESC.
@Index('IDX_membership_cards_user_issued', ['userId', 'issuedAt'])
export class MembershipCard {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_membership_cards_program_id')
  @Column({ type: 'uuid' })
  programId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  // Display string AND the Phase 2 manual scanner fallback, so it carries a
  // random suffix rather than a sequence. Unique platform-wide.
  @Index('UQ_membership_cards_serial', { unique: true })
  @Column({ type: 'varchar' })
  serial!: string;

  @Column({
    type: 'enum',
    enum: MembershipCardStatus,
    enumName: 'membership_cards_status_enum',
    default: MembershipCardStatus.Active,
  })
  status!: MembershipCardStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  issuedAt!: Date;

  // Null means no expiry (the programme's `validityMonths` was null at issue).
  @Column({ type: 'timestamptz', nullable: true })
  expiresAt!: Date | null;

  @Column({ type: 'timestamptz', nullable: true })
  revokedAt!: Date | null;

  // Issuer-only. Never leaves the issuer surfaces, and never appears in a
  // verify response: a scanner learns that a card is invalid, never why.
  @Column({ type: 'text', nullable: true })
  revokedReason!: string | null;

  // Member-controlled, Phase 3 public badge. Default off.
  @Column({ type: 'boolean', default: false })
  isPubliclyVisible!: boolean;
}
