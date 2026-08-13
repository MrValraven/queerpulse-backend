import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * An immutable record of one finance figure changing on the latest
 * `governance_finance_report`. A single PATCH that corrects MRR and one ledger
 * row writes two rows — the unit of audit is the field, not the request, so
 * "who fixed the MRR" is answerable without diffing a blob that also mentions
 * an unrelated ledger tweak. Mirrors `platform_setting_changes` exactly,
 * including `actor_id` being `ON DELETE SET NULL`: an action trail that
 * disappears with its author's account is not a trail.
 */
@Entity('governance_finance_changes')
export class GovernanceFinanceChange {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_governance_finance_changes_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  /** The figure that changed: a scalar key (`mrr`, `sustainerCount`,
   *  `solidarityRate`, `incomeTotal`, `expenseTotal`) or a ledger row
   *  addressed as `income[0]` / `expense[2]`. */
  @Column({ type: 'varchar' })
  field!: string;

  /** Stringified previous value; null when it was null/absent. */
  @Column({ type: 'text', nullable: true })
  oldValue!: string | null;

  /** Stringified new value; null when the new value is null. */
  @Column({ type: 'text', nullable: true })
  newValue!: string | null;

  /** Optional note the admin supplied with the change. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // Indexed: the history list is always "newest first".
  @Index('IDX_governance_finance_changes_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
