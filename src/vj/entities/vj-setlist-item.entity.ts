import {
  Check,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from 'typeorm';
import { VjScene } from './vj-scene.entity';
import { VjSetlist } from './vj-setlist.entity';

/**
 * VJ set list step: one scene at one dense `position` (`0..n-1`) of one set
 * list. The row has its own key, so a scene can sit in a set list more than
 * once (a set often returns to a look). There is no unique index on
 * `position`, so a position rewrite never trips a mid-statement duplicate;
 * reads order by `position ASC, id ASC`. Deleting the set list or the scene
 * cascades the step. Migration `1839500000000-AddVjV2`.
 */
@Entity('vj_setlist_items')
@Index('IDX_vj_setlist_items_setlist_position', ['setlistId', 'position'])
@Index('IDX_vj_setlist_items_scene_id', ['sceneId'])
@Check('CHK_vj_setlist_items_position', `"position" >= 0`)
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

  @Column({ type: 'uuid' })
  sceneId!: string;

  @ManyToOne(() => VjScene, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'scene_id',
    foreignKeyConstraintName: 'FK_vj_setlist_items_scene',
  })
  scene!: VjScene;

  @Column({ type: 'integer' })
  position!: number;
}
