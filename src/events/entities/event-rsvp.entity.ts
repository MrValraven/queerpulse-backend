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

// The closed set `RsvpDetailsModal` (queerpulse FE) offers for "who can see
// this" — mirrors `MemberEventReminderPreferences.EventVisibility`'s "plain
// varchar + DTO `@IsIn`" shape so a future option needs no type migration.
export const RSVP_DETAILS_VISIBILITY_OPTIONS = [
  'everyone',
  'connections',
  'justMe',
] as const;
export type RsvpDetailsVisibility =
  (typeof RSVP_DETAILS_VISIBILITY_OPTIONS)[number];

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

  // ── RSVP details ("Anything we should know?") — self-service, own row only.
  // See `RsvpService.updateRsvpDetails` / `RsvpDetailsModal` (queerpulse FE).
  @Column({ type: 'int', default: 0 })
  guestCount!: number;

  @Column({ type: 'text', nullable: true })
  accessNeeds!: string | null;

  @Column({ type: 'text', nullable: true })
  dietaryNeeds!: string | null;

  @Column({ type: 'varchar', length: 20, nullable: true })
  visibility!: RsvpDetailsVisibility | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
