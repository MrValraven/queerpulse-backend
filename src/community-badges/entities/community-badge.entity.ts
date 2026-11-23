import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Community } from '../../communities/entities/community.entity';
import { User } from '../../users/entities/user.entity';
import { CommunityBadgeRuleType } from '../community-badges.catalog';
import type {
  CommunityBadgeIconKey,
  CommunityBadgeStarterKey,
  CommunityFlairTint,
} from '../community-badges.catalog';

/**
 * Community badges: one automatically awarded badge of one top-level
 * community, its name, icon, tint and the rule and threshold that earn it.
 * Deleting the community deletes its badges through the cascade; a deleted
 * creator account leaves `created_by_id` null. `backfill_requested_at` and
 * `created_by_id` are server-only and reach no response.
 * `IDX_community_badges_community_id_created_at` serves the badge list order;
 * the case-insensitive name index `UQ_community_badges_community_name` lives
 * in the migration only. Migration `1840700000000-AddCommunityBadges`.
 */
@Entity('community_badges')
@Index('IDX_community_badges_community_id_created_at', [
  'communityId',
  'createdAt',
  'id',
])
@Index(
  'UQ_community_badges_community_starter_key',
  ['communityId', 'starterKey'],
  { unique: true, where: '"starter_key" IS NOT NULL' },
)
@Index('IDX_community_badges_backfill_requested_at', ['backfillRequestedAt'], {
  where: '"backfill_requested_at" IS NOT NULL',
})
@Index('IDX_community_badges_created_by_id', ['createdById'], {
  where: '"created_by_id" IS NOT NULL',
})
@Check(
  'CHK_community_badges_threshold',
  `("rule_type" = 'tenure_days' AND "threshold" BETWEEN 30 AND 3650) OR ("rule_type" = 'events_checked_in' AND "threshold" BETWEEN 1 AND 500) OR ("rule_type" = 'volunteer_hours' AND "threshold" BETWEEN 1 AND 1000) OR ("rule_type" = 'posts_and_replies' AND "threshold" BETWEEN 1 AND 5000)`,
)
export class CommunityBadge {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_community_badges',
  })
  id!: string;

  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'community_id',
    foreignKeyConstraintName: 'FK_community_badges_community',
  })
  community?: Community;

  @Column({ type: 'varchar', length: 32, nullable: true })
  starterKey!: CommunityBadgeStarterKey | null;

  @Column({ type: 'varchar', length: 32 })
  name!: string;

  @Column({ type: 'varchar', length: 32 })
  iconKey!: CommunityBadgeIconKey;

  @Column({ type: 'varchar', length: 16 })
  tint!: CommunityFlairTint;

  @Column({
    type: 'enum',
    enum: CommunityBadgeRuleType,
    enumName: 'community_badges_rule_type_enum',
  })
  ruleType!: CommunityBadgeRuleType;

  @Column({ type: 'integer' })
  threshold!: number;

  @Column({ type: 'boolean', default: true })
  isEnabled!: boolean;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_community_badges_created_by',
  })
  createdBy?: User | null;

  @Column({ type: 'timestamptz', nullable: true })
  backfillRequestedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
