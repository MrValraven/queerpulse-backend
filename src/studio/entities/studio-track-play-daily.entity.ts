import { Column, Entity, JoinColumn, ManyToOne, PrimaryColumn } from 'typeorm';
import { StudioTrack } from './studio-track.entity';

/**
 * Anonymous daily play totals: one row per track and UTC day, with no member
 * column, so the totals survive a cleared listening history and a deleted
 * account.
 */
@Entity('studio_track_play_daily')
export class StudioTrackPlayDaily {
  @PrimaryColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_track_play_daily',
  })
  trackId!: string;

  @ManyToOne(() => StudioTrack, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_track_play_daily_track',
  })
  track?: StudioTrack;

  /** UTC day as `YYYY-MM-DD`. */
  @PrimaryColumn({
    type: 'date',
    primaryKeyConstraintName: 'PK_studio_track_play_daily',
  })
  day!: string;

  @Column({ type: 'integer', default: 0 })
  plays!: number;
}
