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
  AwaitingHost = 'awaiting_host',
  Withdrawn = 'withdrawn',
  HostDeclined = 'host_declined',
}

export enum EventInviteSource {
  Host = 'host',
  Member = 'member',
}

/** Statuses that admit anyone to an invite-only event or add them to a recipient list. */
export const ADMITTING_INVITE_STATUSES: readonly EventInviteStatus[] = [
  EventInviteStatus.Pending,
  EventInviteStatus.Accepted,
];

/** A member's open invites, which count toward their guest cap. */
export const OPEN_MEMBER_INVITE_STATUSES: readonly EventInviteStatus[] = [
  EventInviteStatus.Pending,
  EventInviteStatus.AwaitingHost,
];

/** Statuses a member may invite the same person from again. */
export const MEMBER_REINVITABLE_STATUSES: readonly EventInviteStatus[] = [
  EventInviteStatus.Withdrawn,
  EventInviteStatus.HostDeclined,
];

/** Statuses a host may revive by inviting the same person again. */
export const HOST_REVIVABLE_STATUSES: readonly EventInviteStatus[] = [
  EventInviteStatus.Declined,
  EventInviteStatus.Withdrawn,
  EventInviteStatus.HostDeclined,
];

@Entity('event_invites')
@Index('IDX_event_invites_event_inviter', ['eventId', 'inviterId'])
@Unique('UQ_event_invites', ['eventId', 'inviteeId'])
export class EventInvite {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_event_invites_event_id')
  @Column({ type: 'uuid' })
  eventId!: string;

  @Column({ type: 'uuid' })
  inviterId!: string;

  @Index('IDX_event_invites_invitee_id')
  @Column({ type: 'uuid' })
  inviteeId!: string;

  @Column({
    type: 'enum',
    enum: EventInviteStatus,
    enumName: 'event_invites_status_enum',
    default: EventInviteStatus.Pending,
  })
  status!: EventInviteStatus;

  @Column({
    type: 'enum',
    enum: EventInviteSource,
    enumName: 'event_invites_source_enum',
    default: EventInviteSource.Host,
  })
  source!: EventInviteSource;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
