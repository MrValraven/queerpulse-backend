import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { VerificationLevel } from '../verification-level';

/**
 * A member's current identity-verification standing — exactly one row per user
 * (unique `user_id`), holding the HIGHEST level they have reached plus the
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
export class MemberVerification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', unique: true })
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

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
