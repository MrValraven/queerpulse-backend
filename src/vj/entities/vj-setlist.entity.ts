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
import { VjSetlistItem } from './vj-setlist-item.entity';

/**
 * VJ set lists: a named, ordered run of scenes a remote steps through during
 * a show. Set lists are platform show content shared by every admin.
 * `position` is dense (`0..n-1`) and every reorder rewrites it in one
 * transaction, so there is no unique index on it. Deleting a set list
 * cascades its items. `created_by_user_id` is set null when its admin is
 * erased and the row stays; the data export leaves set lists out. Migration
 * `1839500000000-AddVjV2`.
 */
@Entity('vj_setlists')
@Index('IDX_vj_setlists_position', ['position', 'id'])
@Index('IDX_vj_setlists_created_by_user_id', ['createdByUserId'], {
  where: '"created_by_user_id" IS NOT NULL',
})
@Check('CHK_vj_setlists_name', `char_length(btrim("name")) >= 1`)
@Check('CHK_vj_setlists_position', `"position" >= 0`)
export class VjSetlist {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_vj_setlists',
  })
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'integer' })
  position!: number;

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
