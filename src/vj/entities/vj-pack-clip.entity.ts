import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { VjClip } from './vj-clip.entity';
import { VjPack } from './vj-pack.entity';

/**
 * VJ pack membership: one clip at one dense `position` (`0..n-1`) of one
 * pack. The composite primary key keeps a clip in a pack at most once; the
 * same clip can sit in many packs. Both keys cascade on delete, so deleting
 * a pack or a clip takes its memberships with it. Reads order by
 * `position ASC, added_at ASC, clip_id ASC`, so a stray tie stays stable.
 * Migration `1839400000000-AddVj`.
 */
@Entity('vj_pack_clips')
@Index('IDX_vj_pack_clips_pack_position', ['packId', 'position'])
@Index('IDX_vj_pack_clips_clip_id', ['clipId'])
@Check('CHK_vj_pack_clips_position', `"position" >= 0`)
export class VjPackClip {
  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_vj_pack_clips' })
  packId!: string;

  @PrimaryColumn('uuid', { primaryKeyConstraintName: 'PK_vj_pack_clips' })
  clipId!: string;

  @ManyToOne(() => VjPack, (pack) => pack.packClips, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'pack_id',
    foreignKeyConstraintName: 'FK_vj_pack_clips_pack',
  })
  pack!: VjPack;

  @ManyToOne(() => VjClip, (clip) => clip.packClips, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'clip_id',
    foreignKeyConstraintName: 'FK_vj_pack_clips_clip',
  })
  clip!: VjClip;

  @Column({ type: 'integer' })
  position!: number;

  @CreateDateColumn({ type: 'timestamptz' })
  addedAt!: Date;
}
