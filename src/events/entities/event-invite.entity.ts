import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum EventInviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

@Entity('event_invites')
@Unique('UQ_event_invites', ['eventId', 'inviteeId'])
export class EventInvite {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_event_invites_event_id')
  @Column({ type: 'uuid' })
  eventId: string;

  @Column({ type: 'uuid' })
  inviterId: string;

  @Index('IDX_event_invites_invitee_id')
  @Column({ type: 'uuid' })
  inviteeId: string;

  @Column({
    type: 'enum',
    enum: EventInviteStatus,
    enumName: 'event_invites_status_enum',
    default: EventInviteStatus.Pending,
  })
  status: EventInviteStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
