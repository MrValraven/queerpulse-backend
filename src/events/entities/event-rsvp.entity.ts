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

@Entity('event_rsvps')
@Unique('UQ_event_rsvps', ['eventId', 'userId'])
export class EventRsvp {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_event_rsvps_event_id')
  @Column({ type: 'uuid' })
  eventId: string;

  @Index('IDX_event_rsvps_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: RsvpStatus,
    enumName: 'event_rsvps_status_enum',
  })
  status: RsvpStatus;

  @Column({ type: 'int', nullable: true })
  waitlistPosition: number | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt: Date;
}
