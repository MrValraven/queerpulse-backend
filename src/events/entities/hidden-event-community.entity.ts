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

/**
 * One community a member has asked to keep off their upcoming events browse
 * (Highlights, Browse, the calendar). An event leaves that browse when its
 * lead community is hidden and every accepted guest community is hidden too.
 *
 * PRIVATE to `user_id`: nobody else reads this table, and the hidden
 * community is never told. Hiding changes no roster row, so the member keeps
 * their membership and the community's posts in their feed.
 *
 * Both parents cascade. `UQ_hidden_event_communities_user_id_community_id`
 * keeps one row per pair and serves the per-viewer read; the community index
 * serves the cascade. Migration `1837300000000-AddHiddenEventCommunities`.
 */
@Entity('hidden_event_communities')
@Unique('UQ_hidden_event_communities_user_id_community_id', [
  'userId',
  'communityId',
])
export class HiddenEventCommunity {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_hidden_event_communities',
  })
  id!: string;

  /** The member who hid the community. */
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_hidden_event_communities_user_id',
  })
  user?: User;

  /** The community whose events this member no longer browses. */
  @Index('IDX_hidden_event_communities_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'community_id',
    foreignKeyConstraintName: 'FK_hidden_event_communities_community_id',
  })
  community?: Community;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
