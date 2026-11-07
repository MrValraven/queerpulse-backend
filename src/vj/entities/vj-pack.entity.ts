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
import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';
import { VjPackClip } from './vj-pack-clip.entity';

/**
 * VJ packs: an ordered, named set of library clips that a stage loads and
 * shuffles through. Shared by every admin. `position` is dense (`0..n-1`)
 * and every reorder rewrites it in one transaction, so there is no unique
 * index on it. Names are unique case-insensitively, enforced in the service
 * under a table lock. Deleting a pack cascades its memberships and leaves
 * every clip in the library; `created_by_user_id` is set null when its admin
 * is erased. Migration `1839400000000-AddVj`.
 *
 * v2 (`1839500000000-AddVjV2`) links a pack to at most one event, so a stage
 * can show that event's card. Deleting the event sets `event_id` null and
 * leaves the pack and its clips alone.
 */
@Entity('vj_packs')
@Index('IDX_vj_packs_position', ['position', 'id'])
@Index('IDX_vj_packs_created_by_user_id', ['createdByUserId'], {
  where: '"created_by_user_id" IS NOT NULL',
})
@Index('IDX_vj_packs_event_id', ['eventId'], {
  where: '"event_id" IS NOT NULL',
})
@Check('CHK_vj_packs_name', `char_length(btrim("name")) >= 1`)
@Check('CHK_vj_packs_position', `"position" >= 0`)
export class VjPack {
  @PrimaryGeneratedColumn('uuid', { primaryKeyConstraintName: 'PK_vj_packs' })
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
    foreignKeyConstraintName: 'FK_vj_packs_created_by_user',
  })
  createdBy!: User | null;

  /** The linked event, null when the pack stands alone. */
  @Column({ type: 'uuid', nullable: true })
  eventId!: string | null;

  @ManyToOne(() => Event, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_vj_packs_event',
  })
  event!: Event | null;

  @OneToMany(() => VjPackClip, (packClip) => packClip.pack)
  packClips!: VjPackClip[];

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
