import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

export enum RsvpStatus {
  Going = 'going',
  Maybe = 'maybe',
  Waitlisted = 'waitlisted',
  Cancelled = 'cancelled',
}

// Covers `EventsService.attendees`'s paginated `WHERE event_id = ... AND
// status = ... ORDER BY waitlist_position ASC` in one index walk — see
// `1785700500000-AddEventRsvpsStatusOrderIndex.ts`.
@Index('IDX_event_rsvps_status_order', [
  'eventId',
  'status',
  'waitlistPosition',
])
@Entity('event_rsvps')
@Unique('UQ_event_rsvps', ['eventId', 'userId'])
export class EventRsvp {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_rsvps_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Index('IDX_event_rsvps_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: RsvpStatus,
    enumName: 'event_rsvps_status_enum',
  })
  status!: RsvpStatus;

  @Column({ type: 'int', nullable: true })
  waitlistPosition!: number | null;

  // When this attendee's reminder was sent — per-attendee at-most-once claim.
  // Different attendees of one event can have different reminder lead times
  // (`member_event_reminder_preferences`), so the "already reminded" flag lives
  // here, per RSVP, rather than once on the event. Null = not yet reminded.
  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
