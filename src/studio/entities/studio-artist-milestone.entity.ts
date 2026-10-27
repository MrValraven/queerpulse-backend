import {
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { StudioTrack } from './studio-track.entity';

export enum StudioArtistMilestoneKind {
  Followers = 'followers',
  FirstPlacement = 'first_placement',
  TrackPlays = 'track_plays',
  ArtistPlays = 'artist_plays',
}

/**
 * One milestone a Studio artist persona reached: a follower count, the first
 * playlist placement, or a play count. The follow listener, the first
 * placement sweep and the play milestone writer write rows. A row stays when
 * a count later drops, and an unlink deletes every row of the persona.
 *
 * The unique subject index and the ordered read index live in the migration
 * only (the `UQ_users_email_lower` precedent).
 */
@Entity('studio_artist_milestones')
@Index('UQ_studio_artist_milestones_subject', { synchronize: false })
@Index('IDX_studio_artist_milestones_subprofile_reached_at', {
  synchronize: false,
})
@Index('IDX_studio_artist_milestones_track', ['trackId'], {
  where: '"track_id" IS NOT NULL',
})
export class StudioArtistMilestone {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_artist_milestones',
  })
  id!: string;

  @Column({ type: 'uuid' })
  subprofileId!: string;

  @ManyToOne(() => Subprofile, { onDelete: 'CASCADE', onUpdate: 'CASCADE' })
  @JoinColumn({
    name: 'subprofile_id',
    foreignKeyConstraintName: 'FK_studio_artist_milestones_subprofile',
  })
  subprofile?: Subprofile;

  @Column({
    type: 'enum',
    enum: StudioArtistMilestoneKind,
    enumName: 'studio_artist_milestones_kind_enum',
  })
  kind!: StudioArtistMilestoneKind;

  @Column({ type: 'integer' })
  threshold!: number;

  @Column({ type: 'uuid', nullable: true })
  trackId!: string | null;

  @ManyToOne(() => StudioTrack, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_artist_milestones_track',
  })
  track?: StudioTrack | null;

  @Column({ type: 'timestamptz', precision: 3, default: () => 'now()' })
  reachedAt!: Date;
}
