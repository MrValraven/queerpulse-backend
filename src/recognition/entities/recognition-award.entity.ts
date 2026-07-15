import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * An individual badge a member has earned (spec §3 Tier 2 "recognition" —
 * "badges/kudos a member has earned"). `badgeKey` is a stable slug matched
 * against the in-code `BADGE_CATALOG` (`recognition.catalog.ts`); the
 * catalogue supplies `cat`/`name`/`rarity`/`tint`, this row supplies *when
 * and how* — `context` — plus the `awardedAt` timestamp. One award per
 * (user, badge) — awarding the same badge twice is a no-op, not a duplicate
 * row (`UQ_recognition_awards_user_badge`).
 */
@Entity('recognition_awards')
@Unique('UQ_recognition_awards_user_badge', ['userId', 'badgeKey'])
export class RecognitionAward {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_recognition_awards_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'varchar' })
  badgeKey: string;

  // Free text describing when/how this specific member earned the badge
  // (e.g. "Pride Brunch · Jun 2025"). Falls back to the catalogue's generic
  // `earnedContext` when null.
  @Column({ type: 'text', nullable: true })
  context: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  awardedAt: Date;
}
