import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

@Entity('group_memberships')
@Index('UQ_group_memberships_user_group', ['userId', 'groupId'], {
  unique: true,
})
export class GroupMembership {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_group_memberships_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Index('IDX_group_memberships_group_id')
  @Column({ type: 'uuid' })
  groupId: string;

  @Column({ type: 'varchar' })
  role: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
