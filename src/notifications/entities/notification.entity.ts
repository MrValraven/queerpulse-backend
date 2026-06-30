import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
} from 'typeorm';

export enum NotificationType {
  ConnectionRequest = 'connection_request',
  ConnectionAccepted = 'connection_accepted',
  VouchReceived = 'vouch_received',
  PromotedToMember = 'promoted_to_member',
  NewMessage = 'new_message',
  EventInvite = 'event_invite',
  EventReminder = 'event_reminder',
  WaitlistPromoted = 'waitlist_promoted',
}

@Entity('notifications')
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index('IDX_notifications_user_id')
  @Column({ type: 'uuid' })
  userId: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
    enumName: 'notifications_type_enum',
  })
  type: NotificationType;

  @Column({ type: 'jsonb', default: {} })
  payload: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  read: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt: Date;
}
