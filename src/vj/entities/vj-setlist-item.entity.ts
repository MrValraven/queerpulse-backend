import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import type { VjSetlistItemKind, VjStepDurationKind } from '../vj.contract';
import { VjClip } from './vj-clip.entity';
import { VjScene } from './vj-scene.entity';
import { VjSetlist } from './vj-setlist.entity';

/**
 * VJ set list step: one scene or one clip at one dense `position` (`0..n-1`)
 * of one set list. The row has its own key, so a scene or clip can sit in a
 * set list more than once (a set often returns to a look). `kind` names the
 * target: a scene step has `scene_id` set and `clip_id` null, a clip step the
 * reverse (`CHK_vj_setlist_items_kind`). `duration_kind` and `duration_value`
 * are the step's own length, both null to play the set list's default. There
 * is no unique index on `position`, so a position rewrite never trips a
 * mid-statement duplicate; reads order by `position ASC, id ASC`. Deleting
 * the set list, the scene or the clip cascades the step. Migrations
 * `1839500000000-AddVjV2` and `1840200000000-AddVjSequences`.
 */
@Entity('vj_setlist_items')
@Index('IDX_vj_setlist_items_setlist_position', ['setlistId', 'position'])
@Index('IDX_vj_setlist_items_scene_id', ['sceneId'])
@Index('IDX_vj_setlist_items_clip_id', ['clipId'], {
  where: '"clip_id" IS NOT NULL',
})
@Check('CHK_vj_setlist_items_position', `"position" >= 0`)
@Check(
  'CHK_vj_setlist_items_kind',
  `("kind" = 'scene' AND "scene_id" IS NOT NULL AND "clip_id" IS NULL) OR ("kind" = 'clip' AND "clip_id" IS NOT NULL AND "scene_id" IS NULL)`,
)
@Check(
  'CHK_vj_setlist_items_duration',
  `("duration_kind" IS NULL AND "duration_value" IS NULL) OR ("duration_kind" = 'seconds' AND "duration_value" BETWEEN 2 AND 600) OR ("duration_kind" = 'beats' AND "duration_value" IN (4, 8, 16, 32, 64))`,
)
export class VjSetlistItem {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_vj_setlist_items',
  })
  id!: string;

  @Column({ type: 'uuid' })
  setlistId!: string;

  @ManyToOne(() => VjSetlist, (setlist) => setlist.items, {
    onDelete: 'CASCADE',
  })
  @JoinColumn({
    name: 'setlist_id',
    foreignKeyConstraintName: 'FK_vj_setlist_items_setlist',
  })
  setlist!: VjSetlist;

  @Column({ type: 'varchar', length: 10, default: 'scene' })
  kind!: VjSetlistItemKind;

  @Column({ type: 'uuid', nullable: true })
  sceneId!: string | null;

  @ManyToOne(() => VjScene, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'scene_id',
    foreignKeyConstraintName: 'FK_vj_setlist_items_scene',
  })
  scene!: VjScene | null;

  @Column({ type: 'uuid', nullable: true })
  clipId!: string | null;

  @ManyToOne(() => VjClip, { onDelete: 'CASCADE', nullable: true })
  @JoinColumn({
    name: 'clip_id',
    foreignKeyConstraintName: 'FK_vj_setlist_items_clip',
  })
  clip!: VjClip | null;

  @Column({ type: 'varchar', length: 10, nullable: true })
  durationKind!: VjStepDurationKind | null;

  @Column({ type: 'integer', nullable: true })
  durationValue!: number | null;

  @Column({ type: 'integer' })
  position!: number;
}
