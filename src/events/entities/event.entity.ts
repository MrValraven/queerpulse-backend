import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export enum EventVisibility {
  Public = 'public',
  Members = 'members',
  InviteOnly = 'invite_only',
}

export enum EventStatus {
  Draft = 'draft',
  Published = 'published',
  Cancelled = 'cancelled',
}

@Entity('events')
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_events_host_id')
  @Column({ type: 'uuid' })
  hostId: string;

  @Index('UQ_events_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug: string;

  @Column({ type: 'varchar' })
  title: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'timestamptz' })
  startAt: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endAt: Date | null;

  @Column({ type: 'varchar' })
  timezone: string;

  @Column({ type: 'varchar', nullable: true })
  venue: string | null;

  // Optional link to the directory listing (business) hosting this event, so a
  // listing's detail page can show its upcoming events. Free-text `venue` is
  // kept for events not tied to a listed venue; null here means "not at a
  // listed venue".
  @Index('IDX_events_listing_id')
  @Column({ type: 'uuid', nullable: true })
  listingId: string | null;

  @Column({ type: 'boolean', default: false })
  isOnline: boolean;

  @Column({ type: 'varchar', nullable: true })
  onlineUrl: string | null;

  @Column({ type: 'int', nullable: true })
  capacity: number | null;

  @Column({
    type: 'enum',
    enum: EventVisibility,
    enumName: 'events_visibility_enum',
    default: EventVisibility.Public,
  })
  visibility: EventVisibility;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'events_status_enum',
    default: EventStatus.Draft,
  })
  status: EventStatus;

  @Column({ type: 'varchar', nullable: true })
  coverImageUrl: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
