import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/**
 * A member's folder of Studio playlists, shown in their rail and Library.
 *
 * PRIVATE to `user_id`: no other member's response ever carries a field of
 * this table, and its routes sit under `/studio/playlists/`, so the request
 * log and the HTTP metrics skip them (`isStudioListeningRequest`). `position`
 * orders the member's folders, lowest first; ties break on `id`. Which
 * playlists a folder holds lives in `studio_playlist_folder_items`. The
 * account cascades. Migration `1837100000000-AddStudioPlaylistFolders`.
 */
@Entity('studio_playlist_folders')
@Index('IDX_studio_playlist_folders_user_position', [
  'userId',
  'position',
  'id',
])
export class StudioPlaylistFolder {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_playlist_folders',
  })
  id!: string;

  /** The owner. */
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_playlist_folders_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'integer', default: 0 })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
