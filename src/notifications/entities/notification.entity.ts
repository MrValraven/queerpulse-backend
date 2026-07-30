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
  EventCancelled = 'event_cancelled',
  IntroductionMade = 'introduction_made',
  PersonaEndorsed = 'persona_endorsed',
  PersonaFollowed = 'persona_followed',
  Mention = 'mention',
  ForumReply = 'forum_reply',
  // Platform-wide coverage sweep (P3/§K) — see migration
  // `AddMissingNotificationTypes1785004000000`. Each is emitted best-effort at
  // its owning service point and (where a member drove the action) carries that
  // actor's id under the per-type key in `ACTOR_PAYLOAD_KEY`.
  EventRsvp = 'event_rsvp',
  CommunityReply = 'community_reply',
  ForumThreadReply = 'forum_thread_reply',
  JoinRequestReceived = 'join_request_received',
  JoinRequestApproved = 'join_request_approved',
  JoinRequestDeclined = 'join_request_declined',
  JobApplication = 'job_application',
  ListingApproved = 'listing_approved',
  ReportResolved = 'report_resolved',
  AppealResolved = 'appeal_resolved',
  InviteAccepted = 'invite_accepted',
  ListingReview = 'listing_review',
  RoadmapStatus = 'roadmap_status',
}

@Entity('notifications')
@Index('IDX_notifications_user_id_created_at', ['userId', 'createdAt'])
@Index('IDX_notifications_user_id_read', ['userId', 'read'])
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
