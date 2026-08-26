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
  id!: string;

  @Index('IDX_recognition_awards_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({ type: 'varchar' })
  badgeKey!: string;

  // Free text describing when/how this specific member earned the badge
  // (e.g. "Pride Brunch · Jun 2025"). Falls back to the catalogue's generic
  // `earnedContext` when null.
  @Column({ type: 'text', nullable: true })
  context!: string | null;

  /**
   * The member has hidden this badge from how other people see them (SUS-04).
   * Read path: their OWN recognition still returns the badge, flagged
   * `hiddenFromProfile` so the badges page can show it as hidden; another
   * member's view of them omits the row entirely
   * (`RecognitionService.getForUser`, `includePerks = false`). Default false:
   * a badge you earn is visible until you say otherwise.
   *
   * Before this column, the toggle in `BadgeDrawer` wrote to `localStorage`
   * and its own help text admitted it changed nothing for anyone else.
   */
  @Column({ type: 'boolean', default: false })
  hiddenFromProfile!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  awardedAt!: Date;
}
