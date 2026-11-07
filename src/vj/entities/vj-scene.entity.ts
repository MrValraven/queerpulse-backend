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
import { User } from '../../users/entities/user.entity';
import type { VjSceneLook } from '../vj.contract';
import { VjPack } from './vj-pack.entity';

/**
 * VJ scenes: a named, saved look (source, effects, transition, overlay and
 * mix) that a remote recalls in one tap. Scenes are platform show content
 * shared by every admin. `position` is dense (`0..n-1`) and every reorder
 * rewrites it in one transaction, so there is no unique index on it.
 * `pack_id` files a scene under a pack and is set null when that pack goes,
 * so the look survives (it may name clips from several packs).
 * `created_by_user_id` is set null when its admin is erased and the row
 * stays; the data export leaves scenes out. `look` holds a validated
 * `VjSceneLook`; its size cap is a service check. Migration
 * `1839500000000-AddVjV2`.
 */
@Entity('vj_scenes')
@Index('IDX_vj_scenes_position', ['position', 'id'])
@Index('IDX_vj_scenes_pack_id', ['packId'], {
  where: '"pack_id" IS NOT NULL',
})
@Index('IDX_vj_scenes_created_by_user_id', ['createdByUserId'], {
  where: '"created_by_user_id" IS NOT NULL',
})
@Check('CHK_vj_scenes_name', `char_length(btrim("name")) >= 1`)
@Check('CHK_vj_scenes_position', `"position" >= 0`)
@Check('CHK_vj_scenes_look', `jsonb_typeof("look") = 'object'`)
export class VjScene {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_vj_scenes' })
  id!: string;

  /** The pack this scene is filed under, null when unfiled. */
  @Column({ type: 'uuid', nullable: true })
  packId!: string | null;

  @ManyToOne(() => VjPack, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'pack_id',
    foreignKeyConstraintName: 'FK_vj_scenes_pack',
  })
  pack!: VjPack | null;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ type: 'jsonb' })
  look!: VjSceneLook;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_vj_scenes_created_by_user',
  })
  createdBy!: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
