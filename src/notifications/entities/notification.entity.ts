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
  // Co-owned subprofiles (see migration
  // `AddSubprofileInviteNotificationTypes1785800500000`).
  SubprofileInvite = 'subprofile_invite',
  SubprofileCoOwnerJoined = 'subprofile_co_owner_joined',
  // Sent to the member a moderation action lands on (warn/suspend/ban) so they
  // learn the outcome and why — the exact gap the audit named. Delivered with
  // no actor and no preference toggle: a moderation outcome is the platform's
  // word, always written. See migration
  // `AddModerationOutcomeNotificationType1785900000000`.
  ModerationOutcome = 'moderation_outcome',
  // Sent to an event's RSVP'd + invited members when the organizer makes a
  // MATERIAL edit (start time or location) — so nobody shows up at the wrong
  // time or place. Carries no actor and no preference toggle, like
  // `EventCancelled`: a schedule/venue change is need-to-know. See migration
  // `AddEventUpdatedNotificationType1786001600000`.
  EventUpdated = 'event_updated',
}

@Entity('notifications')
@Index('IDX_notifications_user_id_created_at', ['userId', 'createdAt'])
@Index('IDX_notifications_user_id_read', ['userId', 'read'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('IDX_notifications_user_id')
  @Column({ type: 'uuid' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: NotificationType,
    enumName: 'notifications_type_enum',
  })
  type!: NotificationType;

  @Column({ type: 'jsonb', default: {} })
  payload!: Record<string, unknown>;

  @Column({ type: 'boolean', default: false })
  read!: boolean;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
