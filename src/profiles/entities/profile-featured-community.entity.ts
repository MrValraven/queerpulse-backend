import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

/**
 * One community the member has pinned to the "Communities" section of their
 * profile, in display order (`position`, ascending). This table stores ONLY the
 * pin + its order — the community's name/type/role/member-count are all resolved
 * live at read time from `communities` + `community_members` (see
 * `ProfilesService.loadFeaturedCommunities`), so a pin stays correct when the
 * member's role changes and drops out cleanly when they leave the community or
 * it turns private. Mirrors the `group_memberships` join-list pattern.
 */
@Entity('profile_featured_communities')
@Unique('UQ_profile_featured_communities', ['userId', 'communityId'])
export class ProfileFeaturedCommunity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_profile_featured_communities_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({ type: 'uuid' })
  communityId: string;

  /** 0-based display order; the write path assigns it from the array index. */
  @Column({ type: 'int' })
  position: number;
}
