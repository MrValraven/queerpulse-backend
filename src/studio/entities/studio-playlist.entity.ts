import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import { Subprofile } from '../../subprofiles/entities/subprofile.entity';
import { User } from '../../users/entities/user.entity';

export enum StudioPlaylistVisibility {
  Public = 'public',
  Connections = 'connections',
  Private = 'private',
}

/**
 * A member's Studio playlist (Studio v2). `user_id` is the owner and never
 * reaches a non-owner's response. `credit_subprofile_id` names the persona the
 * playlist shows as; `is_credited_to_persona` records that a persona credit
 * was chosen, so when the foreign key nulls the id (the persona was deleted
 * by any path) the playlist still reads as a broken persona credit, which is
 * private, and never as the owner's own list. `updated_at` is millisecond
 * precision because it is a keyset cursor column.
 * Migration `1831500000000-AddStudioPlaylists`.
 */
@Entity('studio_playlists')
@Index('IDX_studio_playlists_user_updated_at', ['userId', 'updatedAt', 'id'])
@Index('IDX_studio_playlists_credit_subprofile_id', ['creditSubprofileId'], {
  where: '"credit_subprofile_id" IS NOT NULL',
})
@Index(
  'IDX_studio_playlists_public_updated_at',
  ['visibility', 'updatedAt', 'id'],
  { where: `"visibility" = 'public'` },
)
@Check(
  'CHK_studio_playlists_persona_credit',
  `"credit_subprofile_id" IS NULL OR "is_credited_to_persona"`,
)
export class StudioPlaylist {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_playlists',
  })
  id!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'user_id',
    foreignKeyConstraintName: 'FK_studio_playlists_user',
  })
  user?: User;

  @Column({ type: 'varchar', length: 80 })
  name!: string;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @Column({
    type: 'enum',
    enum: StudioPlaylistVisibility,
    enumName: 'studio_playlists_visibility_enum',
    default: StudioPlaylistVisibility.Private,
  })
  visibility!: StudioPlaylistVisibility;

  @Column({ type: 'uuid', nullable: true })
  creditSubprofileId!: string | null;

  @ManyToOne(() => Subprofile, {
    onDelete: 'SET NULL',
    onUpdate: 'CASCADE',
    nullable: true,
  })
  @JoinColumn({
    name: 'credit_subprofile_id',
    foreignKeyConstraintName: 'FK_studio_playlists_credit_subprofile',
  })
  creditSubprofile?: Subprofile | null;

  @Column({ type: 'boolean', default: false })
  isCreditedToPersona!: boolean;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
