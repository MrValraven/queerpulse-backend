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
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import type { VjStepDurationKind } from '../vj.contract';
import { VjSetlistItem } from './vj-setlist-item.entity';

/**
 * VJ set lists, shown to people as sequences: a named, ordered run of clip
 * and scene steps that can play itself, and that a remote can also step
 * through by hand during a show. `is_looping` starts the run again from step
 * 1 after the last step; `step_duration_kind` and `step_duration_value` are
 * the default length of a step that has none of its own. Set lists are
 * platform show content shared by every admin. `position` is dense
 * (`0..n-1`) and every reorder rewrites it in one transaction, so there is
 * no unique index on it. Deleting a set list cascades its items.
 * `created_by_user_id` is set null when its admin is erased and the row
 * stays; the data export leaves set lists out. Migrations
 * `1839500000000-AddVjV2` and `1840200000000-AddVjSequences`.
 */
@Entity('vj_setlists')
@Index('IDX_vj_setlists_position', ['position', 'id'])
@Index('IDX_vj_setlists_created_by_user_id', ['createdByUserId'], {
  where: '"created_by_user_id" IS NOT NULL',
})
@Check('CHK_vj_setlists_name', `char_length(btrim("name")) >= 1`)
@Check('CHK_vj_setlists_position', `"position" >= 0`)
@Check(
  'CHK_vj_setlists_step_duration',
  `("step_duration_kind" = 'seconds' AND "step_duration_value" BETWEEN 2 AND 600) OR ("step_duration_kind" = 'beats' AND "step_duration_value" IN (4, 8, 16, 32, 64))`,
)
export class VjSetlist {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_vj_setlists',
  })
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'integer' })
  position!: number;

  @Column({ type: 'boolean', default: false })
  isLooping!: boolean;

  @Column({ type: 'varchar', length: 10, default: 'seconds' })
  stepDurationKind!: VjStepDurationKind;

  @Column({ type: 'integer', default: 8 })
  stepDurationValue!: number;

  @Column({ type: 'uuid', nullable: true })
  createdByUserId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_user_id',
    foreignKeyConstraintName: 'FK_vj_setlists_created_by_user',
  })
  createdBy!: User | null;

  @OneToMany(() => VjSetlistItem, (item) => item.setlist)
  items!: VjSetlistItem[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
