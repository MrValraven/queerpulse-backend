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
  // Volunteering applicant review (SDD 2026-08-18 "volunteer applications").
  // `VolunteerApplicationReceived` goes to the poster when someone applies
  // (carries `actorId`, the applicant); `VolunteerApplicationDecided` goes to
  // the applicant when the poster accepts/declines (no actor — the platform
  // reporting your own status, like `JoinRequestApproved`/`Declined`). See
  // migration `AddVolunteerApplicationNotificationTypes1790700000000`.
  VolunteerApplicationReceived = 'volunteer_application_received',
  VolunteerApplicationDecided = 'volunteer_application_decided',
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
  // Sent to a member when an admin overrides their verification level
  // (`VerificationService.override`, /admin/verifications) — raising,
  // holding, or lowering it — so a change to their standing is never silent.
  // System-driven — no actor and no preference toggle: like `ConcernUpdate`,
  // an admin review outcome is the platform's word, always delivered.
  // Skipped entirely when the override is a no-op (level unchanged). Payload
  // carries `{ fromLevel, toLevel }` for the bell copy. See migration
  // `AddVerificationUpdateNotificationType1789100100000`.
  VerificationUpdate = 'verification_update',
  // Sent to a member when the (forthcoming) XP/badge awarding engine credits
  // them with enough XP to cross a level threshold. System-driven, no actor,
  // no preference toggle: like `VerificationUpdate`, it is the platform
  // reporting on the member's own standing. Payload carries `{ level, name }`
  // for the bell copy. See migration
  // `AddRecognitionNotificationTypes1789600000000`.
  XpLevelUp = 'xp_level_up',
  // Sent to a member when the (forthcoming) XP/badge awarding engine grants
  // them a badge. System-driven, no actor, no preference toggle. Payload
  // carries `{ badgeName }` for the bell copy. See migration
  // `AddRecognitionNotificationTypes1789600000000`.
  BadgeEarned = 'badge_earned',
  // Community governance audit sweep (owner/mod cascade-fix effort). Enum
  // values only here — no emit site wired yet; that belongs to a follow-up
  // task that also wires `CommunityGovernanceLogService.log()` calls into
  // `CommunitiesService`. See migration
  // `AddCommunityGovernanceNotificationTypes1790200000000`.
  //
  // Sent to a member when a community owner/mod changes their roster role.
  CommunityRoleChanged = 'community_role_changed',
  // Sent to a member when a community owner/mod removes them from the roster.
  CommunityMemberRemoved = 'community_member_removed',
  // Sent to the outgoing and incoming owner when a community's ownership is
  // transferred (including the automatic owner→mod promotion on owner
  // account erasure).
  CommunityOwnershipTransferred = 'community_ownership_transferred',
  // Sent to a community's roster when its owner archives it.
  CommunityArchived = 'community_archived',
  // Sent to a community's roster when it is frozen (auto or manual).
  CommunityFrozen = 'community_frozen',
  // Sent to a community's roster when a freeze is lifted.
  CommunityUnfrozen = 'community_unfrozen',
  // Sent to each member slug resolved from `CreateCommunityInput.invites` when
  // a community is created — closes the gap where an invite accepted by the
  // founding flow was silently discarded. NOT a roster add (see
  // `CommunitiesService.seedExtraRoster`'s "no consent-less roster adds"
  // note) — this is purely "you were invited", so the recipient still has to
  // `POST /communities/:slug/join` themselves.
  CommunityInviteReceived = 'community_invite_received',
  // Sent to the invitee when a host/co-host invites them to co-host a
  // gathering (the real invite→accept flow, SDD 2026-08-18 "cohost invite
  // flow"). Carries an actor (the inviter), so block/mute filtering applies
  // like any member-driven type. See migration
  // `AddEventCohostInviteNotificationType1790500000000`.
  EventCohostInvite = 'event_cohost_invite',
  // Sent to a magazine writer applicant when an admin approves or declines
  // their application (SDD 2026-08-18 "magazine writer applications").
  // System-driven — no actor — payload carries `{ reviewNote }`. See
  // migration `AddWriterApplicationNotificationTypes1790700000000`.
  WriterApplicationApproved = 'writer_application_approved',
  WriterApplicationDeclined = 'writer_application_declined',
  // Sent to the claimant once a moderator reviews their claim on an existing
  // business listing (`ListingClaimsService.review`). System-driven — no
  // actor, mirroring `ListingApproved`'s precedent (the platform is telling
  // the claimant about their own claim). See migration
  // `AddListingClaimNotificationTypes1790800200000`.
  ListingClaimApproved = 'listing_claim_approved',
  ListingClaimDeclined = 'listing_claim_declined',
  // Sent to a listing's owner when a moderator ACCEPTS a non-owner member's
  // suggested correction (`ListingEditSuggestionsService.resolve`) — before
  // this, accepting a suggestion silently updated only the suggestion row
  // itself and told the owner nothing. System-driven — no actor and no
  // preference toggle, like `ListingApproved`: it's the platform reporting a
  // change to the owner's own listing, not "moderator X did this". Payload
  // carries `{ source: 'listing', listingSlug, field }` for the bell copy.
  // See migration `AddListingEditSuggestionAcceptedNotificationType1791900000000`.
  ListingEditSuggestionAccepted = 'listing_edit_suggestion_accepted',
  // Sent to a member who follows a topic (`topic_follows`) when a new post
  // lands on it — a forum thread created with a tag matching that topic
  // (`TopicPostLinkService`, content module). Carries the posting member as
  // `payload.actorId` (block/mute applies), plus `topicSlug`/`topicLabel`/
  // `source: 'forum'`/`threadSlug`/`threadTitle` for the bell copy + deep
  // link. No `NotificationPreferenceCategory` gates it — the topic FOLLOW
  // itself is the member's consent, mirroring `HousingListingMatch`'s
  // `alertsEnabled` precedent (see `TopicFollowNotificationsListener`'s
  // docstring). See migration `AddTopicNewPostNotificationType1792400100000`.
  TopicNewPost = 'topic_new_post',
  // Sent to the nominator when an admin approves or dismisses their Change
  // Makers nomination (`AdminChangemakerNominationsService.triage`, COM-17:
  // nominations used to be a one-way black hole — a submit toast, then
  // silence forever). System-driven — no actor — payload carries
  // `{ nomineeName, reviewNote }`. Mirrors `WriterApplicationApproved`/
  // `WriterApplicationDeclined`. See migration
  // `AddChangemakerNominationTriage1792500100000`.
  ChangemakerNominationApproved = 'changemaker_nomination_approved',
  ChangemakerNominationDismissed = 'changemaker_nomination_dismissed',
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
