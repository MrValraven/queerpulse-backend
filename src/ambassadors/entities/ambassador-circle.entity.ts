import {
  Check,
  Column,
  CreateDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
  Unique,
} from 'typeorm';
import { Community } from '../../communities/entities/community.entity';

/**
 * Pins the one community that is the ambassadors' circle. Looked up by this
 * row rather than by slug: a member could found a community whose handle
 * happens to be `queerpulse-ambassadors`, and a slug lookup would then hand
 * every new ambassador to a stranger's community.
 */
@Entity('ambassador_circle')
@Check('CHK_ambassador_circle_singleton', '"id" = 1')
@Unique('UQ_ambassador_circle_community', ['communityId'])
export class AmbassadorCircle {
  @PrimaryColumn({ type: 'smallint', default: 1 })
  id!: number;

  @Column({ type: 'uuid' })
  communityId!: string;

  // The relation behind `communityId`, declared so the entity metadata
  // carries the migration's FK under its exact name
  // (`FK_ambassador_circle_community`, `ON DELETE RESTRICT`) and schema
  // generation never proposes dropping it. Never loaded by any query.
  @ManyToOne(() => Community, { onDelete: 'RESTRICT' })
  @JoinColumn({
    name: 'community_id',
    foreignKeyConstraintName: 'FK_ambassador_circle_community',
  })
  community?: Community;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
