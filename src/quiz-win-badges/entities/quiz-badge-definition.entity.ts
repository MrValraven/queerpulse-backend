import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { CommunityBadgeIconKey } from '../../community-badges/community-badges.catalog';
import type {
  BadgeRarity,
  BadgeTint,
} from '../../recognition/recognition.catalog';
import { User } from '../../users/entities/user.entity';

/**
 * Quiz win badges: one badge of the staff library, with its names, its
 * descriptions and its look. `badge_key` is always `quiz:` followed by the row
 * id (a migration check keeps them tied) and is the key of every award row.
 * The case-insensitive name indexes `UQ_quiz_badge_definitions_name_en` and
 * `UQ_quiz_badge_definitions_name_pt` are expression indexes and live in the
 * migration only. A deleted creator account leaves `created_by_id` null, and
 * `created_by_id` is server-only. Migration `1840910000000-AddQuizWinBadges`.
 * Only a staff delete of an unused definition removes a row; slots and wins
 * that name a definition block its deletion through `ON DELETE RESTRICT`.
 */
@Entity('quiz_badge_definitions')
@Index('UQ_quiz_badge_definitions_badge_key', ['badgeKey'], { unique: true })
@Index('IDX_quiz_badge_definitions_created_by_id', ['createdById'], {
  where: '"created_by_id" IS NOT NULL',
})
export class QuizBadgeDefinition {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_quiz_badge_definitions',
  })
  id!: string;

  @Column({ type: 'varchar', length: 48 })
  badgeKey!: string;

  @Column({ type: 'varchar', length: 40 })
  nameEn!: string;

  @Column({ type: 'varchar', length: 40, nullable: true })
  namePt!: string | null;

  @Column({ type: 'varchar', length: 140 })
  descriptionEn!: string;

  @Column({ type: 'varchar', length: 140, nullable: true })
  descriptionPt!: string | null;

  @Column({ type: 'varchar', length: 32 })
  iconKey!: CommunityBadgeIconKey;

  @Column({ type: 'varchar', length: 16 })
  tint!: BadgeTint;

  @Column({ type: 'varchar', length: 16 })
  rarity!: BadgeRarity;

  @Column({ type: 'timestamptz', nullable: true })
  archivedAt!: Date | null;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_quiz_badge_definitions_created_by_id',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
