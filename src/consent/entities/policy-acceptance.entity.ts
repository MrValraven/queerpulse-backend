import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** How a policy acceptance was obtained. */
export enum PolicyAcceptanceSource {
  /** The post-signup onboarding wizard's guidelines step (first agreement). */
  Onboarding = 'onboarding',
  /** The re-acceptance sheet, shown when a stored revision fell behind. */
  Reacceptance = 'reacceptance',
}

/**
 * Append-only evidence that a member agreed to a specific revision of the Terms
 * and the Community Guidelines at a specific moment (ID-14).
 *
 * WHY A TABLE AND NOT JUST THE TWO COLUMNS
 * ----------------------------------------
 * `users.terms_version` / `users.guidelines_version` are single cells: the next
 * acceptance OVERWRITES the last one. That is enough to decide "does this member
 * need re-prompting", which is why the gate itself needs no migration — but it
 * is not evidence. The whole point of the item is that if a member is later
 * moderated under a rule added after they joined, someone can show that they saw
 * it. A cell that only ever holds the newest value cannot answer "when did they
 * agree to 1.1, and what were they on before that".
 *
 * WHY NOT REUSE `consent_record`
 * ------------------------------
 * It looked like the right append-only home and it is not.
 * `ConsentService.myConsent` defines a member's CURRENT cookie/monitoring
 * consent as "the latest `consent_record` row". Appending a policy-acceptance
 * row there would therefore rewrite that member's cookie consent as a
 * side-effect of agreeing to the guidelines — `analytics: false,
 * monitoring: false` would read back as a withdrawal they never made. The two
 * logs answer different questions and must not share a table.
 *
 * There is deliberately no unique constraint: history is the product. A member
 * who agrees to 1.0, then 1.1, then 1.2 leaves three rows.
 */
@Entity('policy_acceptance')
@Index('IDX_policy_acceptance_user_id', ['userId', 'createdAt'])
export class PolicyAcceptance {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  /** The Terms revision agreed to, as stamped by the server. */
  @Column({ type: 'varchar', length: 32 })
  termsVersion!: string;

  /** The Community Guidelines revision agreed to, as stamped by the server. */
  @Column({ type: 'varchar', length: 32 })
  guidelinesVersion!: string;

  /**
   * What the member had on file immediately BEFORE this acceptance — the half
   * the overwritten `users` columns destroy. NULL when nothing was on record
   * (an account that predates the column, or a first agreement).
   */
  @Column({ type: 'varchar', length: 32, nullable: true })
  previousTermsVersion!: string | null;

  @Column({ type: 'varchar', length: 32, nullable: true })
  previousGuidelinesVersion!: string | null;

  @Column({
    type: 'enum',
    enum: PolicyAcceptanceSource,
    enumName: 'policy_acceptance_source_enum',
  })
  source!: PolicyAcceptanceSource;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
