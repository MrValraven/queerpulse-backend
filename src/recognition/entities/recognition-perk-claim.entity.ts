import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * A member permanently claiming a one-time perk (spec §3 Tier 2
 * "recognition" — the perks page's "Already claimed" group, e.g. "Vouch
 * access"). `perkKey` matches an entry in the in-code `PERK_CATALOG`. Once
 * claimed, a perk stays in the "claimed" state even if the member's level
 * later changes — claiming is one-way (`UQ_recognition_perk_claims_user_perk`
 * prevents double-claiming).
 */
@Entity('recognition_perk_claims')
@Unique('UQ_recognition_perk_claims_user_perk', ['userId', 'perkKey'])
export class RecognitionPerkClaim {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_recognition_perk_claims_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  perkKey: string;

  @CreateDateColumn({ type: 'timestamptz' })
  claimedAt: Date;
}
