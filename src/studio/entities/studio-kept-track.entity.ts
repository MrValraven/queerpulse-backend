import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
} from 'typeorm';

/**
 * A track a confirmed buyer keeps after the artist persona unlinks from its
 * account. One row per distinct source track, shared by every buyer of it.
 * `source_audio_key` holds the live track's key until the private copy
 * lands; `audio_key` then holds the copy and the source key clears. The row
 * holds no key into the catalog (no foreign key to `studio_tracks` or
 * `subprofiles`), so nothing in it follows the re-keyed catalog. Migration
 * `1838000000000-AddStudioPurchases`.
 */
@Entity('studio_kept_tracks')
@Check(
  'CHK_studio_kept_tracks_audio',
  '"source_audio_key" IS NOT NULL OR "audio_key" IS NOT NULL',
)
export class StudioKeptTrack {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_kept_tracks',
  })
  id!: string;

  /** The track title at unlink. */
  @Column({ type: 'varchar', length: 200 })
  title!: string;

  @Column({ type: 'integer', nullable: true })
  durationSeconds!: number | null;

  /** `audio/mpeg` or `audio/mp4`. */
  @Column({ type: 'varchar', length: 40 })
  audioContentType!: string;

  @Column({ type: 'varchar', length: 500, nullable: true })
  sourceAudioKey!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  audioKey!: string | null;

  @Column({ type: 'integer', default: 0 })
  copyAttempts!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
