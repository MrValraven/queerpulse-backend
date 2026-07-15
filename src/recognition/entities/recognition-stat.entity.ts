import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * One row per user: lifetime XP total (spec §3 Tier 2 "recognition"). Level,
 * progress-within-level and the level ladder are all *derived* from `xp` via
 * the static `LEVEL_LADDER_DEF` in `recognition.catalog.ts` — never persisted,
 * so the ladder can be rebalanced without a migration.
 *
 * No row yet for a user simply means 0 XP (Level 1 · Newcomer) — the service
 * treats a missing row the same as `{ xp: 0 }` rather than erroring.
 */
@Entity('recognition_stats')
export class RecognitionStat {
  @PrimaryColumn({ name: 'user_id', type: 'uuid' })
  userId: string;

  @Column({ type: 'int', default: 0 })
  xp: number;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
