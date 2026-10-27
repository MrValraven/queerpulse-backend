import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioTrack } from './studio-track.entity';

/**
 * One play in a member's own listening history. Only that member reads it,
 * and it carries no artist column (attribution happens at read time). A
 * scheduled job prunes rows after 13 months.
 *
 * The ordered history index lives in the migration only (the
 * `UQ_users_email_lower` precedent).
 */
@Entity('studio_listens')
@Index('IDX_studio_listens_user_played_at', { synchronize: false })
@Index('IDX_studio_listens_track_played_at', ['trackId', 'playedAt'])
export class StudioListen {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_listens',
  })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_listens_user',
  })
  user?: User;

  @Column({ type: 'uuid' })
  trackId!: string;

  @ManyToOne(() => StudioTrack, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_listens_track',
  })
  track?: StudioTrack;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  playedAt!: Date;
}
