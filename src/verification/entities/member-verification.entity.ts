import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import {
  VerificationGrantedBy,
  VerificationLevel,
  VerificationType,
} from '../verification-level';

/**
 * A member's current identity-verification standing — exactly one row per
 * `(user_id, type)` pair (today only `type = 'identity'`, so effectively one
 * row per user), holding the HIGHEST level they have reached plus the
 * provenance of how they reached it.
 *
 * GDPR Art.9 note: verification of a government ID or biometric is
 * special-category processing, and this platform deliberately never stores the
 * document image or any biometric. This row keeps only a LEVEL, the METHOD/
 * PROVIDER that granted it, and an OPAQUE `provider_ref` (the external
 * provider's session/verification id) — enough to prove a real verification
 * event happened and to reconcile with the provider, but nothing that is itself
 * special-category data. The document check lives entirely behind the external
 * `IdentityVerificationProvider` seam.
 */
@Entity('member_verifications')
@Index(['userId', 'type'], { unique: true })
export class MemberVerification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: VerificationLevel,
    enumName: 'member_verification_level_enum',
    default: VerificationLevel.Email,
  })
  level!: VerificationLevel;

  /** How the current level was earned, e.g. `google_oauth`, `phone_otp`,
   * `id_document`, `manual_review`. NULL only on a bare seeded row. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  method!: string | null;

  /** The external system that granted the level (`dev_phone`, `stub_identity`,
   * `admin`), or NULL for the email floor. Swapping in Stripe Identity / Didit
   * changes this value, not the shape. */
  @Column({ type: 'varchar', length: 64, nullable: true })
  provider!: string | null;

  /** Opaque reference the provider hands back (its verification-session id).
   * NEVER a document or biometric — just a correlation key. Set at identity
   * session start so the success callback can map back to this member. */
  @Column({ type: 'varchar', length: 255, nullable: true })
  providerRef!: string | null;

  /** When the current level was reached. NULL on a pre-verification row. */
  @Column({ type: 'timestamptz', nullable: true })
  verifiedAt!: Date | null;

  /** Which verification dimension this row covers. Only `identity` exists
   * today; the `(user_id, type)` uniqueness leaves room for more. */
  @Column({
    type: 'enum',
    enum: VerificationType,
    enumName: 'verification_type_enum',
    default: VerificationType.Identity,
  })
  type!: VerificationType;

  /** Whether the current level was earned through the ordinary step-up flow
   * or set directly by an admin override. */
  @Column({
    type: 'enum',
    enum: VerificationGrantedBy,
    enumName: 'verification_granted_by_enum',
    default: VerificationGrantedBy.MemberEarned,
  })
  grantedBy!: VerificationGrantedBy;

  /** The admin who last reviewed/overrode this row, if any. NULL when the
   * level was reached entirely through the member-facing flow. */
  @Column({ type: 'uuid', nullable: true })
  reviewedByUserId!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
