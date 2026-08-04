import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('subprofile_members')
@Unique('UQ_subprofile_members', ['subprofileId', 'userId'])
export class SubprofileMember {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_subprofile_members_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId!: string;

  @Index('IDX_subprofile_members_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  joinedAt!: Date;
}
