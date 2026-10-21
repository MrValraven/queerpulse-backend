import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { StudioPlaylistFolder } from './studio-playlist-folder.entity';
import { StudioPlaylist } from './studio-playlist.entity';

/**
 * Where one member keeps one playlist: the folder it sits in. A playlist
 * with no row here sits at the top level of the member's rail.
 *
 * The row belongs to the member, never to the playlist: an owner, an editor
 * and everyone who saved a playlist each file it on their own, so the folder
 * reference lives on this per-member row and `studio_playlists` stays as it
 * is. `UQ_studio_playlist_folder_items_user_playlist` keeps a playlist in at
 * most one of the member's folders. The service admits a playlist that is
 * open to the member by link and that they own, edit (an `active` seat) or
 * saved, with blocks applied, and the read leaves out a row whose playlist
 * no longer qualifies (`PLAYLIST_FILEABLE_BY_MEMBER_SQL`).
 *
 * PRIVATE to `user_id`, like the folder. The folder, the playlist and the
 * account cascade, so deleting a folder puts its playlists back at the top
 * level. Migration `1837100000000-AddStudioPlaylistFolders`.
 */
@Entity('studio_playlist_folder_items')
@Unique('UQ_studio_playlist_folder_items_user_playlist', [
  'userId',
  'playlistId',
])
@Index('IDX_studio_playlist_folder_items_folder_id', ['folderId'])
@Index('IDX_studio_playlist_folder_items_playlist_id', ['playlistId'])
export class StudioPlaylistFolderItem {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_playlist_folder_items',
  })
  id!: string;

  @Column({ type: 'uuid' })
  folderId!: string;

  @ManyToOne(() => StudioPlaylistFolder, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'folder_id',
    foreignKeyConstraintName: 'FK_studio_playlist_folder_items_folder',
  })
  folder?: StudioPlaylistFolder;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_playlist_folder_items_user',
  })
  user?: User;

  @Column({ type: 'uuid' })
  playlistId!: string;

  @ManyToOne(() => StudioPlaylist, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'playlist_id',
    foreignKeyConstraintName: 'FK_studio_playlist_folder_items_playlist',
  })
  playlist?: StudioPlaylist;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
