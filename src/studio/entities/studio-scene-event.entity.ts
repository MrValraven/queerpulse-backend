import {
  CreateDateColumn,
  Column,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryColumn,
} from 'typeorm';
import { Event } from '../../events/entities/event.entity';
import { User } from '../../users/entities/user.entity';
import { StudioScene } from './studio-scene.entity';

/**
 * Studio discovery: an event staff pinned to a scene. A pin stays after the
 * event passes (the admin list marks it) and the member read skips it.
 * Migration `1831800000000-AddStudioDiscovery`.
 */
@Entity('studio_scene_events')
@Index('IDX_studio_scene_events_event_id', ['eventId'])
export class StudioSceneEvent {
  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_scene_events',
  })
  sceneId!: string;

  @ManyToOne(() => StudioScene, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'scene_id',
    foreignKeyConstraintName: 'FK_studio_scene_events_scene',
  })
  scene?: StudioScene;

  @PrimaryColumn({
    type: 'uuid',
    primaryKeyConstraintName: 'PK_studio_scene_events',
  })
  eventId!: string;

  @ManyToOne(() => Event, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'event_id',
    foreignKeyConstraintName: 'FK_studio_scene_events_event',
  })
  event?: Event;

  @Column({ type: 'uuid', nullable: true })
  pinnedById!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({
    name: 'pinned_by_id',
    foreignKeyConstraintName: 'FK_studio_scene_events_pinned_by',
  })
  pinnedBy?: User | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
