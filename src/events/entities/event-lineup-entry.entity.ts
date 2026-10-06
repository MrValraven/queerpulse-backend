import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum EventLineupEntryStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

// One member's place on an event's lineup ("who performed"), one row per
// (event, member). An organizer invites; the member accepts or declines
// (`EventLineupService`). Only accepted rows are public. `role` stays a
// free-ish craft label (see the note on `role` below).
@Entity('event_lineup_entries')
@Unique('UQ_event_lineup_entries', ['eventId', 'userId'])
export class EventLineupEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_lineup_entries_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid' })
  userId!: string;

  // Free-ish craft label ("dj", "chef", ...). Deliberately no enum or FK to
  // `SubprofileKind`: a host may credit a craft that is no persona kind yet.
  @Column({ type: 'varchar', length: 40 })
  role!: string;

  @Column({
    type: 'enum',
    enum: EventLineupEntryStatus,
    enumName: 'event_lineup_entries_status_enum',
    default: EventLineupEntryStatus.Pending,
  })
  status!: EventLineupEntryStatus;

  // The organizer who sent the invite. Null for rows written before invites
  // existed, and after the inviter's account is erased (ON DELETE SET NULL).
  @Index('IDX_event_lineup_entries_invited_by_id')
  @Column({ type: 'uuid', nullable: true })
  invitedById!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  respondedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
