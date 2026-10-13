import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { StudioPlaylist } from './studio-playlist.entity';
import { StudioTrack } from './studio-track.entity';

/**
 * One entry of a Studio playlist (Studio v2). `(playlist_id, position)` is
 * unique and DEFERRABLE INITIALLY IMMEDIATE, so a reorder or a renumber moves
 * every position in one statement. `track_id` cascades on delete (a deleted
 * track leaves the playlist) and is set null on update: a persona unlink gives
 * each of its tracks a fresh id, and the entry keeps the old track out of
 * reach as an unavailable row for the owner, so the named persona's track
 * never reappears under the pseudonymous one.
 * Migration `1831500000000-AddStudioPlaylists`.
 */
@Entity('studio_playlist_tracks')
@Unique(
  'UQ_studio_playlist_tracks_playlist_position',
  ['playlistId', 'position'],
  {
    deferrable: 'INITIALLY IMMEDIATE',
  },
)
@Unique('UQ_studio_playlist_tracks_playlist_track', ['playlistId', 'trackId'])
@Check('CHK_studio_playlist_tracks_position', `"position" >= 1`)
export class StudioPlaylistTrack {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_playlist_tracks',
  })
  id!: string;

  @Column({ type: 'uuid' })
  playlistId!: string;

  @ManyToOne(() => StudioPlaylist, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'playlist_id',
    foreignKeyConstraintName: 'FK_studio_playlist_tracks_playlist',
  })
  playlist?: StudioPlaylist;

  @Index('IDX_studio_playlist_tracks_track_id')
  @Column({ type: 'uuid', nullable: true })
  trackId!: string | null;

  @ManyToOne(() => StudioTrack, {
    onDelete: 'CASCADE',
    onUpdate: 'SET NULL',
    nullable: true,
  })
  @JoinColumn({
    name: 'track_id',
    foreignKeyConstraintName: 'FK_studio_playlist_tracks_track',
  })
  track?: StudioTrack | null;

  @Column({ type: 'smallint' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  addedAt!: Date;
}
