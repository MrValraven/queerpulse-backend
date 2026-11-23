import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { Community } from '../../communities/entities/community.entity';
import { User } from '../../users/entities/user.entity';
import { CommunityBadge } from './community-badge.entity';

/**
 * Community badges: one badge earned by one member. An award stays when the
 * member leaves or the badge is disabled; deleting the badge, the community
 * or the account deletes it through the cascade.
 * `UQ_community_badge_awards_badge_user` is the award insert's
 * `ON CONFLICT DO NOTHING` target, `IDX_community_badge_awards_community_user`
 * serves the per-member reads and `IDX_community_badge_awards_user_id` the
 * account erasure. `is_notified` is true once a `community_badge_earned`
 * notification was written for the award, and is server-only. Migration
 * `1840700000000-AddCommunityBadges`.
 */
@Entity('community_badge_awards')
@Unique('UQ_community_badge_awards_badge_user', ['badgeId', 'userId'])
@Index('IDX_community_badge_awards_community_user', ['communityId', 'userId'])
export class CommunityBadgeAward {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_community_badge_awards',
  })
  id!: string;

  @Column({ type: 'uuid' })
  badgeId!: string;

  @ManyToOne(() => CommunityBadge, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'badge_id',
    foreignKeyConstraintName: 'FK_community_badge_awards_badge',
  })
  badge?: CommunityBadge;

  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'community_id',
    foreignKeyConstraintName: 'FK_community_badge_awards_community',
  })
  community?: Community;

  @Index('IDX_community_badge_awards_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_community_badge_awards_user',
  })
  user?: User;

  @CreateDateColumn({ type: 'timestamptz' })
  awardedAt!: Date;

  @Column({ type: 'boolean', default: false })
  isNotified!: boolean;
}
