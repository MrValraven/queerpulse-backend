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
  // Sent to a persona's co-owners when its CREATOR deletes it, so they learn
  // the shared persona is gone (the creator who deleted it is excluded). No
  // preference toggle (like `ModerationOutcome`) — the persona no longer
  // exists, so this is need-to-know; block/mute still applies via the deleting
  // creator as the `actorId`. See migration
  // `AddSubprofileDeletedNotificationType1787700000000`.
  SubprofileDeleted = 'subprofile_deleted',
  // Sent to a co-owner when the persona's CREATOR removes them from it
  // (`SubprofilesService.removeMember`), so they learn they no longer co-own
  // the shared persona (a creator kick previously notified no one). Like
  // `SubprofileDeleted` it carries the persona name in its payload and no
  // preference toggle — need-to-know — while block/mute still applies via the
  // removing creator as the `actorId`. See migration
  // `AddSubprofileMemberRemovedNotificationType1787700100000`.
  SubprofileMemberRemoved = 'subprofile_member_removed',
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
  // Sent to a member the FIRST time a persona's `replaceSection` save newly
  // credits their @handle as a collaborator (Personas discovery Phase 5,
  // Moment 6). `replaceSection` deletes-and-recreates a section on every
  // save with no stable item ids, so the emit site diffs the persona's WHOLE
  // collaborator set (across every section) before vs. after the save and
  // only fires for handles that are genuinely new — resaving with the same
  // collaborators never re-fires. No preference toggle (like
  // `ModerationOutcome`/`EventUpdated`), but block/mute IS honoured via the
  // crediting persona's owner as the `actorId` on `notifications.create`.
  // See migration `AddSubprofileCreditNotificationType1786700100000`.
  SubprofileCredit = 'subprofile_credit',
  // Sent to the OTHER party (editor → writer, or writer → editor) when
  // someone posts to a magazine piece's editor↔writer message thread
  // (Magazine Desk Phase 7, Task F1). Carries an actor (`authorId`) so
  // block/mute filtering applies like any member-driven type. See migration
  // `AddMagazinePieceMessageNotificationType1787300100000`.
  MagazinePieceMessage = 'magazine_piece_message',
  // Sent to a safe space's listing OWNER when a member vouches for their space
  // (`SafeSpaceVouchesService.createVouch`) — before this, a safe-space vouch
  // notified no one. Carries the voucher (`voucherId`) as the actor so
  // block/mute filtering applies like any member-driven type; the id is OMITTED
  // from the payload for an ANONYMOUS vouch so the bell/push never names them,
  // while the block/mute gate still fires via the `actorId` argument. Push is
  // gated on the `Vouches` category. See migration
  // `AddSafeSpaceVouchNotificationType1787500000000`.
  SafeSpaceVouch = 'safe_space_vouch',
  // Sent to a member when a NEW housing listing goes live that matches one of
  // their saved searches with alerts on (Wave B3 P2.5,
  // `HousingSavedSearchAlertsListener`). System-driven — no actor and no
  // preference toggle (the saved search's `alertsEnabled` flag IS the member's
  // consent); the payload carries the listing slug/title/area for the bell,
  // push, and deep link. See migration
  // `AddHousingListingMatchNotificationType1788300200000`.
  HousingListingMatch = 'housing_listing_match',
  // Sent to the submitter of a governance concern when an admin moves it to a
  // terminal outcome (resolved/dismissed) on the /admin/concerns dashboard, so
  // the "you'll get an update when it's resolved" promise is kept. System-driven
  // — no actor and no preference toggle: it's the platform's word on a concern
  // they raised. A logged-out submitter is emailed instead (no account to
  // notify). Payload carries `{ source: 'concern', status, category? }` for the
  // bell copy. See migration `AddConcernUpdateNotificationType1788600000000`.
  ConcernUpdate = 'concern_update',
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
