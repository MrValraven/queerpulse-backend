import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';

export enum EventCohostInviteStatus {
  Pending = 'pending',
  Accepted = 'accepted',
  Declined = 'declined',
}

@Entity('event_cohost_invites')
@Unique('UQ_event_cohost_invites', ['eventId', 'inviteeId'])
export class EventCohostInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_cohost_invites_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid' })
  inviterId!: string;

  @Index('IDX_event_cohost_invites_invitee_id')
  @Column({ type: 'uuid' })
  inviteeId!: string;

  @Column({ type: 'varchar', length: 40 })
  role!: string;

  @Column({ type: 'varchar', length: 40 })
  commitment!: string;

  @Column({ type: 'text', nullable: true })
  message!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  replyByDate!: Date | null;

  @Column({
    type: 'enum',
    enum: EventCohostInviteStatus,
    enumName: 'event_cohost_invites_status_enum',
    default: EventCohostInviteStatus.Pending,
  })
  status!: EventCohostInviteStatus;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
