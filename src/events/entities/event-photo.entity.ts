import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

// A gathering photo attached to an event. `storageKey` is a
// `gathering-photos/<uploaderId>/<uuid>.<ext>` key; it is globally unique so a
// single uploaded object is attached to at most one event.
@Entity('event_photos')
@Unique('UQ_event_photos_storage_key', ['storageKey'])
export class EventPhoto {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_event_photos_event_id')
  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'text' })
  storageKey: string;

  @Column({ type: 'uuid' })
  uploaderId: string;

  @Column({ type: 'varchar', nullable: true })
  caption: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
