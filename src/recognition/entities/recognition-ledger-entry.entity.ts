import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * Append-only row in a member's XP history — the "receipts" list on the
 * frontend Badges page. Written from `RecognitionAwardingService.recompute`
 * whenever XP increases: one precise row per newly-earned badge, plus one
 * coarser row for signal-driven growth (this backend computes XP lazily from
 * live counts, not discrete per-action events, so a generic "recalculated"
 * row is the honest granularity — see `recompute`'s ledger-writing comment).
 * Rows are never updated or deleted; `xp` can be negative for a future
 * correction/adjustment path (none exists yet).
 */
@Entity('recognition_ledger_entries')
@Index('IDX_recognition_ledger_entries_user_created', ['userId', 'createdAt'])
export class RecognitionLedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'integer' })
  xp!: number;

  // Present only on a correction/adjustment row (no write path yet).
  @Column({ type: 'text', nullable: true })
  reason!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
