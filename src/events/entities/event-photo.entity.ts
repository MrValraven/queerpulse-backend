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
  id!: string;

  @Index('IDX_event_photos_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'text' })
  storageKey!: string;

  // Nullable + indexed since
  // `AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`: the
  // `uploader_id` FK is `ON DELETE SET NULL` (which cannot fire on a NOT NULL
  // column), so an uploader erasing their account NULLs this while the photo
  // survives. Always non-null at write time (`EventPhotosService`). The
  // `IDX_event_photos_uploader_id` index backs that SET-NULL column.
  @Index('IDX_event_photos_uploader_id')
  @Column({ type: 'uuid', nullable: true })
  uploaderId!: string | null;

  @Column({ type: 'varchar', nullable: true })
  caption!: string | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
