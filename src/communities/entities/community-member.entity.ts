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

@Entity('community_members')
@Unique('UQ_community_members', ['communityId', 'userId'])
export class CommunityMember {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_community_members_community_id')
  @Column({ type: 'uuid' })
  communityId: string;

  @Index('IDX_community_members_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: RosterRole,
    enumName: 'community_members_role_enum',
  })
  role: RosterRole;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt: Date;
}
