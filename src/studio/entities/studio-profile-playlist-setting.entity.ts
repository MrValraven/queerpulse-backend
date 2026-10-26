import {
  Column,
  Entity,
  JoinColumn,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

/** Most playlists a member can feature on their profile. */
export const STUDIO_PROFILE_PLAYLISTS_MAX_FEATURED = 12;

/**
 * Whether a member's Studio playlists appear on their public profile, and
 * which ones lead it. One row per member, created on the first save; a
 * member without a row shows everything (`isShown` true, nothing featured).
 * `featured_ids` keeps the member's own order. It holds plain ids with no
 * foreign key, so a deleted playlist is dropped when the setting is read.
 * The account cascades. Migration
 * `1837110000000-AddStudioProfilePlaylistSettings`.
 */
@Entity('studio_profile_playlist_settings')
export class StudioProfilePlaylistSetting {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_profile_playlist_settings',
  })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_profile_playlist_settings_user',
  })
  user?: User;

  @Column({ type: 'boolean', default: true })
  isShown!: boolean;

  @Column({ type: 'uuid', array: true, default: () => "'{}'" })
  featuredIds!: string[];

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
