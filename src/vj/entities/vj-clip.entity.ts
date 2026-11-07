import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import {
  DEFAULT_VJ_FIT_MODE,
  type VjClipMimeType,
  type VjFitMode,
  type VjLoopMode,
  type VjMediaKind,
  type VjSpeed,
} from '../vj.contract';
import { VjPackClip } from './vj-pack-clip.entity';

/**
 * VJ clips: platform artwork shared by every admin, one MP4, WebM or GIF with
 * its WebP thumbnail, played on the live stage at `admin/vj`. The storage
 * keys (`vj-clips/...`, `vj-thumbnails/...`) name nobody, so account erasure
 * keeps the rows and the stored objects; `created_by_user_id` is set null
 * when its admin is erased. Every CHECK mirrors a service check that runs
 * first, so a driver error never carries a clip title. Deleting a clip
 * cascades its memberships in every pack. Migration `1839400000000-AddVj`.
 *
 * v2 (`1839500000000-AddVjV2`) adds the clip defaults a stage picks up on a
 * tap (favorite, speed, loop points and loop mode) and the animated preview
 * (`vj-previews/...`, a key that names nobody). Loop points belong to videos
 * only and leave a playable span of at least 250 ms.
 */
@Entity('vj_clips')
@Unique('UQ_vj_clips_storage_key', ['storageKey'])
@Unique('UQ_vj_clips_thumbnail_storage_key', ['thumbnailStorageKey'])
@Unique('UQ_vj_clips_preview_storage_key', ['previewStorageKey'])
@Index('IDX_vj_clips_created_at', ['createdAt', 'id'])
@Index('IDX_vj_clips_created_by_user_id', ['createdByUserId'], {
  where: '"created_by_user_id" IS NOT NULL',
})
@Check('CHK_vj_clips_title', `char_length(btrim("title")) >= 1`)
@Check('CHK_vj_clips_media_kind', `"media_kind" IN ('video', 'gif')`)
@Check(
  'CHK_vj_clips_mime_type',
  `"mime_type" IN ('video/mp4', 'video/webm', 'image/gif')`,
)
@Check(
  'CHK_vj_clips_kind_matches_type',
  `("media_kind" = 'gif') = ("mime_type" = 'image/gif')`,
)
@Check('CHK_vj_clips_byte_size', `"byte_size" BETWEEN 1 AND 104857600`)
@Check(
  'CHK_vj_clips_dimensions',
  `"width" BETWEEN 1 AND 16384 AND "height" BETWEEN 1 AND 16384`,
)
@Check(
  'CHK_vj_clips_duration',
  `CASE WHEN "media_kind" = 'video' THEN ("duration_ms" IS NOT NULL AND "duration_ms" BETWEEN 1 AND 3600000) ELSE "duration_ms" IS NULL END`,
)
@Check('CHK_vj_clips_fit_mode', `"fit_mode" IN ('fill', 'fit')`)
@Check('CHK_vj_clips_storage_key', `"storage_key" LIKE 'vj-clips/%'`)
@Check(
  'CHK_vj_clips_thumbnail_storage_key',
  `"thumbnail_storage_key" LIKE 'vj-thumbnails/%'`,
)
@Check(
  'CHK_vj_clips_default_speed',
  `"default_speed" IN (0.25, 0.5, 1, 1.5, 2, 4)`,
)
@Check('CHK_vj_clips_loop_mode', `"loop_mode" IN ('loop', 'pingPong')`)
@Check(
  'CHK_vj_clips_loop_points',
  `("loop_in_ms" IS NULL AND "loop_out_ms" IS NULL) OR ("media_kind" = 'video' AND ("loop_in_ms" IS NULL OR "loop_in_ms" >= 0) AND ("loop_out_ms" IS NULL OR "loop_out_ms" <= "duration_ms") AND COALESCE("loop_out_ms", "duration_ms") - COALESCE("loop_in_ms", 0) >= 250)`,
)
@Check(
  'CHK_vj_clips_preview_storage_key',
  `"preview_storage_key" IS NULL OR "preview_storage_key" LIKE 'vj-previews/%'`,
)
export class VjClip {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_vj_clips' })
  id!: string;

  @Column({ type: 'varchar', length: 120 })
  title!: string;

  @Column({ type: 'varchar', length: 10 })
  mediaKind!: VjMediaKind;

  @Column({ type: 'varchar', length: 20 })
  mimeType!: VjClipMimeType;

  @Column({ type: 'integer' })
  byteSize!: number;

  @Column({ type: 'integer' })
  width!: number;

  @Column({ type: 'integer' })
  height!: number;

  /** Set for a video, null for a GIF. */
  @Column({ type: 'integer', nullable: true })
  durationMs!: number | null;

  @Column({ type: 'varchar', length: 200 })
  storageKey!: string;

  @Column({ type: 'varchar', length: 200 })
  thumbnailStorageKey!: string;

  @Column({ type: 'varchar', length: 10, default: DEFAULT_VJ_FIT_MODE })
  fitMode!: VjFitMode;

  /** Starred in the library; a shuffle with source `favorites` draws from these. */
  @Column({ type: 'boolean', default: false })
  isFavorite!: boolean;

  /** The playback speed a stage takes when this clip goes live. */
  @Column({ type: 'double precision', default: 1 })
  defaultSpeed!: VjSpeed;

  /** Loop start in ms; null loops from 0. Always null for a GIF. */
  @Column({ type: 'integer', nullable: true })
  loopInMs!: number | null;

  /** Loop end in ms; null loops to the end. Always null for a GIF. */
  @Column({ type: 'integer', nullable: true })
  loopOutMs!: number | null;

  @Column({ type: 'varchar', length: 10, default: 'loop' })
  loopMode!: VjLoopMode;

  /** The short WebM or MP4 preview under `vj-previews/`, null until one is
   *  uploaded. */
  @Column({ type: 'varchar', length: 200, nullable: true })
  previewStorageKey!: string | null;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_vj_clips_created_by_user',
  })
  createdBy!: User | null;

  @OneToMany(() => VjPackClip, (packClip) => packClip.clip)
  packClips!: VjPackClip[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
