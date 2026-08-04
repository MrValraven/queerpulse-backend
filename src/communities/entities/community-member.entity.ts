import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum RosterRole {
  Owner = 'owner',
  Mod = 'mod',
  Member = 'member',
}

// Covers `CommunitiesService.roster`'s paginated `WHERE community_id = ...
// ORDER BY joined_at ASC` in one index walk — see
// `1785700400000-AddCommunityMembersRosterOrderIndex.ts`.
@Index('IDX_community_members_roster_order', ['communityId', 'joinedAt'])
@Entity('community_members')
@Unique('UQ_community_members', ['communityId', 'userId'])
export class CommunityMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_community_members_community_id')
  @Column({ type: 'uuid' })
  communityId!: string;

  @Index('IDX_community_members_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: RosterRole,
    enumName: 'community_members_role_enum',
  })
  role!: RosterRole;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt!: Date;
}
