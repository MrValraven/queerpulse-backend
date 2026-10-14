import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';

export enum StudioSceneState {
  Active = 'active',
  Archived = 'archived',
}

/**
 * Studio discovery: a scene staff create (name, city, blurb, cover). A
 * release owner opts a release into one active scene. Archiving keeps every
 * release link and every pinned event; the member reads then answer 404 and
 * cards read `scene: null`. `position` orders the active scenes on the home
 * row and carries no unique constraint, since a reorder rewrites every
 * active position at once and archived rows keep their old number.
 * Migration `1831800000000-AddStudioDiscovery`.
 */
@Entity('studio_scenes')
@Unique('UQ_studio_scenes_slug', ['slug'])
@Index('IDX_studio_scenes_status_position', ['status', 'position'])
export class StudioScene {
  @PrimaryGeneratedColumn('uuid', {
    primaryKeyConstraintName: 'PK_studio_scenes',
  })
  id!: string;

  @Column({ type: 'varchar', length: 60 })
  slug!: string;

  @Column({ type: 'varchar', length: 60 })
  name!: string;

  @Column({ type: 'varchar', length: 60 })
  city!: string;

  @Column({ type: 'text', nullable: true })
  blurb!: string | null;

  /** A storage key from the admin's own `work-image` upload. */
  @Column({ type: 'varchar', nullable: true })
  coverKey!: string | null;

  @Column({
    type: 'enum',
    enum: StudioSceneState,
    enumName: 'studio_scenes_status_enum',
    default: StudioSceneState.Active,
  })
  status!: StudioSceneState;

  @Column({ type: 'smallint' })
  position!: number;

  @Column({ type: 'uuid', nullable: true })
  createdById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'created_by_id',
    foreignKeyConstraintName: 'FK_studio_scenes_created_by',
  })
  createdBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
