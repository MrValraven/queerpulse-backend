import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/** The five sections `governance_overview` holds — one enum value per jsonb
 *  column, so an audit row always says exactly which section changed. */
export enum OverviewSection {
  Health = 'health',
  ModerationSteps = 'moderationSteps',
  Council = 'council',
  Principles = 'principles',
  Decisions = 'decisions',
}

/**
 * An immutable record of one `governance_overview` section changing.
 * Mirrors `GovernanceFinanceChange`, but at section granularity rather than
 * per-scalar: overview sections are edited (and rendered) as whole ordered
 * arrays, not individual fields, so `before`/`after` hold the full array
 * snapshot for that section. `actor_id` is `ON DELETE SET NULL`, like every
 * other audit trail in this repo — the trail survives erasure of its author's
 * account.
 */
@Entity('governance_overview_changes')
export class GovernanceOverviewChange {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_governance_overview_changes_section')
  @Column({
    type: 'enum',
    enum: OverviewSection,
    enumName: 'governance_overview_section_enum',
  })
  section!: OverviewSection;

  @Index('IDX_governance_overview_changes_actor_id')
  @Column({ type: 'uuid', nullable: true })
  actorId!: string | null;

  @Column({ type: 'jsonb' })
  before!: unknown;

  @Column({ type: 'jsonb' })
  after!: unknown;

  /** Optional free-text reason the admin supplied with the change. */
  @Column({ type: 'text', nullable: true })
  note!: string | null;

  // Indexed: the history list is always "newest first".
  @Index('IDX_governance_overview_changes_created_at')
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
