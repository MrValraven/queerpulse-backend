import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { StudioRelease } from './studio-release.entity';

/**
 * Studio v3: a version note on a published release. Version 1 is the
 * original publish and has no row, so stored versions start at 2.
 * `created_at` has millisecond precision because it is compared with
 * `studio_releases.tracks_changed_at` in JS.
 * Migration `1832000100000-AddStudioArtistTools`.
 */
@Entity('studio_release_versions')
@Unique('UQ_studio_release_versions_release_version', ['releaseId', 'version'])
@Check('CHK_studio_release_versions_version', `"version" >= 2`)
@Check('CHK_studio_release_versions_note', `btrim("note") <> ''`)
export class StudioReleaseVersion {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_release_versions',
  })
  id!: string;

  @Column({ type: 'uuid' })
  releaseId!: string;

  @ManyToOne(() => StudioRelease, {
    onDelete: 'CASCADE',
    onUpdate: 'CASCADE',
  })
  @JoinColumn({
    name: 'release_id',
    foreignKeyConstraintName: 'FK_studio_release_versions_release',
  })
  release?: StudioRelease;

  @Column({ type: 'smallint' })
  version!: number;

  @Column({ type: 'varchar', length: 280 })
  note!: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;
}
