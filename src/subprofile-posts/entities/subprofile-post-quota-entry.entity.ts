import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';

/**
 * One row per persona post ever created, kept for 24 hours. The daily post
 * limit and the three-alerts-a-day throttle count these, so deleting a post
 * frees neither (a create, delete, create loop would otherwise alert
 * followers without end). Pruned on every create and kept off the wire.
 * Migration `1832000100000-AddStudioArtistTools`.
 */
@Entity('subprofile_post_quota_entries')
@Index('IDX_subprofile_post_quota_entries_subprofile_created_at', [
  'subprofileId',
  'createdAt',
])
export class SubprofilePostQuotaEntry {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_subprofile_post_quota_entries',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_subprofile_post_quota_entries_subprofile',
  })
  subprofile?: Subprofile;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
