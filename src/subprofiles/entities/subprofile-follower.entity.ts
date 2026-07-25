import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

@Entity('subprofile_followers')
@Unique('UQ_subprofile_followers', ['subprofileId', 'followerId'])
export class SubprofileFollower {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_subprofile_followers_subprofile_id')
  @Column({ type: 'uuid' })
  subprofileId: string;

  @Index('IDX_subprofile_followers_follower_id')
  @Column({ type: 'uuid' })
  followerId: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
