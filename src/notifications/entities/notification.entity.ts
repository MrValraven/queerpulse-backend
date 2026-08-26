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
  // Sent to the submitter of any non-concern intake form (`intake_submissions`)
  // when an admin moves it to a terminal status. System-driven, no actor, no
  // preference toggle, mirroring `ConcernUpdate`.
  //
  // Exists because `ConcernUpdate` was carrying every intake kind: a Culture
  // playlist submission, a micro-grant application and a sober-host listing all
  // reached the member's bell reading "The concern you raised has been
  // reviewed", which is both wrong and, for a member who never raised a
  // concern, alarming. `IntakesService.notifySubmitter` now branches on
  // `submission.kind`, so only `governance_concern` keeps `ConcernUpdate`.
  //
  // Payload carries `{ source: 'intake', kind, status }`: `kind` names the form
  // back to the member ("your playlist submission"), `status` is the terminal
  // outcome (`resolved`/`dismissed`) the copy branches on. The submitted
  // payload itself never rides along — see `PAYLOAD_ALLOWLIST`. No deep link:
  // there is no member-facing page for an intake submission. See migration
  // `AddIntakeAndDsarNotificationTypes1794660000000`.
  IntakeReviewed = 'intake_reviewed',
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
  // The public Q&A on a business listing (`listing_public_questions`).
  // `ListingPublicQuestion` goes to the listing's OWNER when a member asks
  // something on their page (carries `actorId`, the asker, so a blocked/muted
  // asker is filtered by `NotificationsService.create` like any other
  // member-driven type). `ListingPublicQuestionAnswered` goes to the ASKER when
  // the question is answered; it carries an `actorId` only when the OWNER
  // answered, and deliberately none when a moderator did, because the asker is
  // owed the answer, not the name of the staff member who wrote it.
  //
  // Neither has a preference toggle, matching `ListingReview`/`ListingApproved`
  // and every other listing type: these are the platform telling you about
  // something that happened on your own listing, or the answer to a question
  // you personally asked. See migration
  // `AddListingPublicQuestionNotificationTypes1794300000000`.
  ListingPublicQuestion = 'listing_public_question',
  ListingPublicQuestionAnswered = 'listing_public_question_answered',

  // Co-manager seats on a business directory listing
  // (`ListingCoManagersService`). A listing has exactly one `owner_id`, so a
  // venue run by two people shares its page through an invited, accepted
  // co-manager seat instead.
  //
  // `ListingCoManagerInvite` goes to the INVITED member: it is the only way
  // they learn an owner has asked them, and nothing happens to their access
  // until they answer it, so it is member-driven and carries the owner as
  // `actorId`. `ListingCoManagerInviteAccepted`/`...Declined` go back to the
  // OWNER with the member as `actorId`, closing the loop on an invitation the
  // owner sent by hand.
  //
  // None of the three has a preference toggle, matching every other listing
  // type here: they are consequences of an act one of the two parties
  // performed, not a feed. Payloads carry `listingSlug`/`listingName` (and
  // `inviteId` on the invite), never a note or any other prose. See migration
  // `AddListingCoManagerEnumValues1794530000000`.
  ListingCoManagerInvite = 'listing_co_manager_invite',
  ListingCoManagerInviteAccepted = 'listing_co_manager_invite_accepted',
  ListingCoManagerInviteDeclined = 'listing_co_manager_invite_declined',
  // Sent to a business listing's OWNER when a member's gathering attaches
  // itself to their venue (LOC-16). The attachment starts `pending`, and this
  // is the ask: until the owner confirms it, the gathering is withheld from
  // the anonymous, CDN-cached version of their public page.
  //
  // NO ACTOR, deliberately, and no `actorId` argument at the emit site. The
  // block/mute filter on `NotificationsService.create` would otherwise let a
  // host the owner has blocked attach a gathering to that owner's business
  // page and suppress the only warning they would ever get. The bell names
  // the venue and the gathering; who organised it is on the gathering's own
  // page, where the owner reads it under their own authentication.
  //
  // Never raised for a draft, nor for a gathering scoped tighter than
  // `members`: neither can reach the venue's public page, so there is nothing
  // to consent to and naming it would disclose a private gathering to
  // somebody outside its audience. Publishing or widening it raises the ask
  // then, exactly once (`events.venue_owner_notified_at`).
  //
  // Payload: `{ source: 'listing', listingSlug, listingName, eventSlug,
  // eventTitle }`. The `notifications_type_enum` label is added by
  // `AddEventVenueConfirmation1794790000000`, alongside the columns the state
  // itself lives in.
  VenueEventAttachment = 'venue_event_attachment',
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
  // Sent to the owner/mod who submitted a "suggest a tag" feedback request
  // when an admin marks it resolved from the `admin/community-tag-requests`
  // inbox (`AdminCommunityTagRequestsService.resolve`). System-driven — no
  // actor and no preference toggle, mirroring `ListingEditSuggestionAccepted`/
  // `ConcernUpdate`: it's the platform reporting on the requester's own
  // submission, not "admin X did this". INFORMATIONAL ONLY — resolving never
  // adds the label to the live `COMMUNITY_TAGS` vocabulary; see
  // `CommunityTagRequest`'s docstring. Payload carries
  // `{ source: 'community', communitySlug, label }` for the bell copy + deep
  // link back to the community. See migration
  // `AddCommunityTagRequestResolvedNotificationType1793400100000`.
  CommunityTagRequestResolved = 'community_tag_request_resolved',
  // Sent to a barter listing's OWNER when a member proposes a swap on it
  // (`BarterService.createProposal`). Before this, a proposal reached the
  // owner ONLY as a DM through `MessagingService.deliverEnquiry`, so the bell
  // showed nothing at all. Both channels are kept: the DM is the conversation
  // (and the channel that carries push), this is the bell.
  //
  // Carries the proposer as `payload.actorId` so block/mute filtering applies
  // like any member-driven type. The payload deliberately carries only
  // `barterListingId` + `listingOffer` (the listing's OWN public headline,
  // directly analogous to `ForumReply`'s allowed `threadTitle`) — the
  // proposal's `message` is member-authored private text and belongs in the DM
  // thread, never in the notification payload. No preference toggle: a swap
  // proposal on your own listing is need-to-know, like
  // `VolunteerApplicationReceived`. See migration
  // `AddBarterProposalReceivedNotificationType1793720000000`.
  BarterProposalReceived = 'barter_proposal_received',
  // Communities build (2026-08-23). Every value below is appended to
  // `notifications_type_enum` by migration
  // `AddCommunityNotificationTypes1793940000000`.
  //
  // Sent to a community's members whose `community_members.notification_level`
  // is `all` when a new post lands in the community, excluding the author. The
  // per-member level IS the consent here, the same shape as
  // `HousingListingMatch`'s `alertsEnabled` and `TopicNewPost`'s follow, so no
  // `NotificationPreferenceCategory` gates it. Carries the poster as
  // `payload.actorId` so block/mute filtering applies like any member-driven
  // type, plus the community slug and post id for the deep link.
  CommunityNewPost = 'community_new_post',
  // Sent to a community's members when an owner/mod marks a post as an
  // ANNOUNCEMENT. Reaches everyone above `muted` (levels `all`,
  // `announcements` and `mentions`), because an announcement is the one thing
  // a member who turned the volume down still asked to hear. Carries the
  // announcing owner/mod as `payload.actorId`.
  CommunityAnnouncement = 'community_announcement',
  // Sent to the member an owner/mod bans from a community
  // (`community_bans`), so a removal is never silent and they are not left
  // guessing why the room vanished. System-driven, no preference toggle, like
  // `ModerationOutcome`: it is the platform's word on an action taken against
  // them. Deliberately carries NO actor id, so the ban does not name which
  // moderator applied it; the payload carries the community name plus the
  // moderator's `reason` where one was given.
  CommunityBanned = 'community_banned',
  // Sent to PLATFORM STAFF when a community's moderators file an owner-review
  // request (`community_owner_review_requests`), reporting an owner who has
  // gone unreachable. The same stamp
  // (`communities.needs_owner_review_at`) the automatic orphan path sets, so
  // both routes land on one admin surface. Carries the requesting moderator as
  // `payload.actorId` and the community slug plus their reason.
  CommunityOwnerReviewRequested = 'community_owner_review_requested',
  // Sent to a community's members whose notification level is `all` when an
  // owner/mod pins a new resource to the community's shelf
  // (`community_resources`), because a shelf nobody is told about is a shelf
  // nobody reads. Carries the adding owner/mod as `payload.actorId` plus the
  // resource title and community slug.
  CommunityResourceAdded = 'community_resource_added',
  // Sent to a community's owner, co-owners and moderators when PLATFORM STAFF
  // offer that community support (OPS-05, `community_support_offers`). The
  // admin health modal's "Offer support" button wrote nothing at all until
  // this existed: it showed a success toast and the community never heard
  // from anyone.
  //
  // System-driven in the same sense as `CommunityReportFiled`: it carries NO
  // actor id, so a moderator's personal block of whichever staff member typed
  // the offer cannot swallow it, and the bell reads as the platform speaking.
  // The payload carries the community's own name and slug and nothing else —
  // the staff member's note is member-authored prose that lives behind the
  // community's own mod-tools authentication, which is where it is read.
  //
  // Always delivered, like the other governance types: it is the platform
  // reaching a room that is having a hard time, which is not a volume a
  // category switch may turn down. IN-APP is the channel; QueerPulse sends no
  // email, so no copy for this type may say anything is on its way. Appended
  // to `notifications_type_enum` by migration
  // `AddCommunitySupportOfferedNotificationType1795660200000`.
  CommunitySupportOffered = 'community_support_offered',

  // "Tell a moderator a report has landed" (TS-04). Until these existed,
  // filing a report fired no notification of any kind: the only signal was a
  // count pill you had to already be inside the admin console to see, which
  // left the platform's 1-hour outing/doxxing SLA uncovered every night and
  // weekend. Both values are appended to `notifications_type_enum` by
  // migration `AddReportFiledNotificationTypes1794600000000` and written by
  // `ReportNotificationsListener` off the existing `REPORT_CREATED` event.
  //
  // `ReportFiled` goes to platform staff (`users.role` of `moderator` or
  // `admin`) and deep-links to the platform moderation queue.
  // `CommunityReportFiled` goes to the owner, co-owners and mods of the
  // community a reported post or reply belongs to (or of a reported community
  // itself) and deep-links to that community's mod tools.
  //
  // Neither carries an actor id, deliberately: the bell must never name the
  // reporter, whether or not the report was filed anonymously, and a staff
  // alert must not be suppressible by a block or mute between the reporter and
  // the moderator on duty. Neither has a `NotificationPreferenceCategory`
  // either, matching `ModerationOutcome`: this is duty mail, always written.
  //
  // Emergency severity is NOT a separate enum value. `reports.severity` is
  // already a four-value axis (emergency/high/medium/low) and the payload has
  // to carry it for the other three regardless, so the payload's `severity`
  // field is the single place urgency lives: the bell keys its urgent copy and
  // icon off it, and the push transport pushes only on `emergency`.
  ReportFiled = 'report_filed',
  CommunityReportFiled = 'community_report_filed',

  // --- Security and account lifecycle (ID-06) -------------------------------
  //
  // The first values in this enum that are about the ACCOUNT rather than about
  // something happening inside the community. All three are appended to
  // `notifications_type_enum` by migration
  // `AddSecurityAlertsAndDeviceLabel1794610100000`.
  //
  // Three properties they share:
  //  - System-driven. No `actorId`, ever: there is no other member involved,
  //    so there is nothing for the block/mute gate to act on. It is the
  //    platform telling you about your own account.
  //  - No `NotificationPreferenceCategory`. Those categories are content
  //    volume controls and these are not content. `SecurityNewSignIn` gets its
  //    own dedicated member switch instead (`member_preferences.
  //    login_alerts_enabled`), gated at the EMIT site in `AuthService` rather
  //    than in `NotificationsService`, so turning it off silences the bell and
  //    the push together.
  //  - The payload never carries anything that could out somebody. A coarse
  //    device name and a timestamp are the whole of it.

  /**
   * Sent to a member when a refresh-token FAMILY is created for a device they
   * have not signed in from before (`AuthService.issueTokens`). Payload carries
   * `{ source: 'security', deviceLabel, signedInAt, familyId }` — the coarse
   * device name from `auth/device-label.ts`, never the raw User-Agent — and
   * deep-links to `/account/sessions`, the one place the member can act on it.
   *
   * Never fired for a member's FIRST-EVER session: an alert about the browser
   * they are looking at as they read it is noise, and a noisy security alert is
   * an ignored security alert.
   */
  SecurityNewSignIn = 'security_new_sign_in',

  /**
   * Sent to a member when the data export they asked for has finished building
   * and is ready to download.
   *
   * NO EMIT SITE YET. `AccountExportService` is where it belongs, and that
   * module is out of scope for the change that added this value; the enum
   * value, the migration and the frontend renderer land together so wiring it
   * later is a one-line call rather than a second `ALTER TYPE`.
   *
   * IMPORTANT: this is an in-app notification (plus push). QueerPulse sends no
   * email and never will, so nothing about this type may be described as one.
   */
  AccountExportReady = 'account_export_ready',

  /**
   * Sent to a member whose account-deletion grace period is about to end,
   * while cancelling is still possible.
   *
   * Emitted by `AccountDeletionProcessorService.warnUpcomingDeletions`, the
   * same daily cron that runs the erasure sweep, once per member at roughly
   * three days out. Fires ONCE: the row is claimed with a conditional UPDATE on
   * `deletion_request.final_warning_sent_at`, the same way the erasure sweep
   * claims a row, so a second replica ticking at the same moment cannot
   * double-send.
   *
   * Payload carries `{ source: 'account', daysRemaining }` — a NUMBER, which
   * the frontend mirrors onto `count` for CLDR pluralisation — so the copy
   * counts down on the frontend and the backend never composes a sentence.
   * `source: 'account'` deep-links to the delete-account page, where cancelling
   * still lives.
   */
  AccountDeletionFinalWarning = 'account_deletion_final_warning',

  /**
   * Sent to a member when an admin reaches a terminal decision on the GDPR
   * data-subject request they filed (`AdminDsarService.updateStatus`, both the
   * `resolved` and the `rejected` outcome).
   *
   * Exists because that emit site was borrowing `ConcernUpdate`, so a member
   * who asked for a copy of their data got a bell reading "The concern you
   * raised has been reviewed and resolved" — a different promise about a
   * different thing.
   *
   * System-driven, no actor and no preference toggle: an operator's decision on
   * a statutory right is the platform's word, so block/mute must never suppress
   * it. Payload carries `{ source: 'account_dsar', status, reference }` — the
   * `reference` is the member's own case number, which is how they match the
   * row to what they filed, and `source` deep-links to the data-request page
   * where their reference history is listed.
   */
  DsarResolved = 'dsar_resolved',

  /**
   * Sent to every active member when the desk ships a magazine issue
   * (`MagazinePieceService.shipIssue`, gated on the issue's
   * `digestSendOnPublish` toggle).
   *
   * This REPLACES the members'-digest mailing. Shipping used to queue one
   * email per confirmed newsletter subscriber and drain that queue on a cron;
   * QueerPulse delivers no email, so the send path is gone and this bell is
   * the announcement. The curated running order and per-piece blurbs the desk
   * wrote for the digest now render on the issue's own page
   * (`GET /magazine/issues/:number/contents`), which is where this row deep-
   * links.
   *
   * System-driven — no actor. Payload carries `{ source: 'magazine',
   * issueNumber, issueTitle }`; the two issue fields are desk-authored
   * editorial headline text, already public the moment the issue ships. No
   * preference toggle: an issue is quarterly, so this is at most four rows a
   * year.
   *
   * See migration `AddMagazineIssuePublishedNotificationType1794833000000`.
   */
  MagazineIssuePublished = 'magazine_issue_published',

  /**
   * Sent to a housing listing's LISTER when a moderator decides on it:
   * approved, changes requested, rejected, or taken down after publication
   * (`HousingListingModerationService.decide`, LOC-01).
   *
   * Before this, a member could submit a home and never hear anything again:
   * every listing was forced to `review`, the only transition endpoint had no
   * client, and no decision notified anybody.
   *
   * System-driven and deliberately carries NO actor id, like `CommunityBanned`
   * and `ModerationOutcome`: the bell must never name which moderator acted,
   * and a decision about a member's own listing must not be suppressible by a
   * block between the two of them. No `NotificationPreferenceCategory` either,
   * because this is the platform's word on the member's own submission rather
   * than content volume.
   *
   * Payload carries `{ source: 'housing', slug, title, decision, reason? }`.
   * `reason` is MODERATOR-authored (the same class of value `CommunityBanned`
   * and `VerificationUpdate` already forward), stripped of markup at the write
   * boundary, and it is the substance: a refusal with no sentence attached is
   * exactly what this path exists to prevent. `decision` is one of `approve` /
   * `request_changes` / `reject` / `take_down`, which the client keys its copy
   * off. Nothing member-authored is ever in this payload.
   *
   * IN-APP PLUS PUSH. QueerPulse sends no email and never will, so nothing
   * about this type may be described as one.
   *
   * See migration `AddHousingModerationDecisionEnums1794720100000`.
   */
  HousingListingDecision = 'housing_listing_decision',

  /**
   * Sent to the member who submitted a story when staff decide on it
   * (`AdminStorySubmissionsService.decide`). Before this existed, a submission
   * sat at "submitted" forever and the member was never told anything (CON-01).
   *
   * System-driven, no actor: the bell never names which staff member decided.
   * Payload carries `{ decision, workingTitle }` — `decision`
   * (`accepted | declined | commissioned`) branches the copy, and
   * `workingTitle` is the member's OWN headline read back to them so the row
   * says which story. The decider's reply note is deliberately absent: it is
   * staff-authored prose, and it belongs on the tracker card the member opens
   * rather than in a bell payload.
   *
   * QueerPulse sends no email and never will, so this bell plus the note on
   * the tracker IS how a submitter hears back.
   *
   * See migration `AddStorySubmissionDecision1794833100000`.
   */
  StorySubmissionDecided = 'story_submission_decided',
  // --- The four approval queues that used to go nowhere (LOC-19) ------------
  //
  // Each value below is one queue's answer to the same question: a member did
  // real work into a submission surface, so what were they told about it? The
  // answer was nothing at all, in all four cases.
  //
  // The four share four properties, documented once here:
  //  - SYSTEM-DRIVEN, no actor id. The platform is reporting on the member's
  //    OWN submission, like `ListingApproved`. The bell never names which
  //    moderator decided, and a block between the member and the moderator on
  //    duty must not suppress the answer to their own submission.
  //  - No `NotificationPreferenceCategory` (all four map to `null`): this is
  //    the outcome of something the member asked for, never content volume.
  //  - ONE value per queue covering every outcome, with a `decision` field the
  //    client keys its copy off. Same shape as `VolunteerApplicationDecided`
  //    and `HousingListingDecision`.
  //  - IN-APP PLUS PUSH. QueerPulse sends no email and never will, so nothing
  //    about any of these may be described as one.
  //
  // All four are appended to `notifications_type_enum` by migration
  // `AddApprovalQueueNotificationTypes1794740000000`.

  /**
   * The member whose reading-group proposal an admin decided on
   * (`AdminReadingGroupProposalsService`). An approval creates a real community
   * the proposer OWNS and this is how they find it; a decline carries the
   * reviewer's required reason.
   *
   * Payload: `{ source: 'community', decision: 'approved' | 'declined', book,
   * communitySlug?, communityName?, reason? }`. `book` is the member's own
   * submitted title read back to them; `reason` is moderator-authored (the
   * class of value `CommunityBanned` already forwards). `source` +
   * `communitySlug` are the structural deep-link pair the client resolves.
   */
  ReadingGroupProposalDecided = 'reading_group_proposal_decided',

  /**
   * The member who submitted a listing into a vetted housing group
   * (`POST /housing-groups/:slug/listings`), when a housing moderator decides.
   * Every group listing is forced to `review` on create and stayed invisible
   * until someone approved it, with no word to the poster either way.
   *
   * Payload: `{ source: 'housing_group', decision: 'live' | 'question' |
   * 'declined', groupSlug, groupName, listingTitle, reason? }`. The listing's
   * description, price and accessibility text never ride along: they live on
   * the page the deep link opens.
   */
  GroupListingDecided = 'group_listing_decided',

  /**
   * The member who suggested a landlord directory entry, when a moderator
   * publishes it, sends it back to review, or removes it.
   *
   * Payload: `{ source: 'landlord', decision: 'live' | 'review' | 'removed',
   * landlordSlug, landlordName, reason? }`. A landlord is a THIRD PARTY, never
   * a member, so `landlordName` is directory content rather than personal data.
   */
  LandlordSuggestionDecided = 'landlord_suggestion_decided',

  /**
   * The member who asked for an introduction to a landlord, when the
   * facilitator team accepts or declines it. They passed a phone-verification
   * step-up and the affirming pledge to ask, and then heard nothing.
   *
   * Payload: `{ source: 'landlord', decision: 'accepted' | 'declined',
   * landlordSlug, landlordName, reason? }`. An ACCEPT deliberately carries no
   * contact details: the introduction is made by a person, and a landlord's
   * contact information is not something a bell payload hands out.
   */
  LandlordIntroRequestDecided = 'landlord_intro_request_decided',
  /**
   * Sent to everyone holding a stake in a gathering (a live RSVP of any kind,
   * or a standing invite) when its host or a co-host posts an announcement
   * (`EventAnnouncementsService.create`, LOC-06). "We moved to the back
   * room", "the door code is 4471", "the tram is out, walk up from Martim
   * Moniz".
   *
   * Carries the sending organiser as `payload.actorId`, so block/mute
   * filtering applies like any member-driven type. The payload also carries
   * the announcement's own `body`: every recipient is somebody the host
   * addressed on purpose, and every one of them can read the same text on the
   * event page, so withholding it from the bell would only turn "the door
   * code is 4471" into "a host said something".
   *
   * No `NotificationPreferenceCategory` gates it: the member's RSVP is the
   * consent, the same shape `HousingListingMatch`'s `alertsEnabled` and
   * `TopicNewPost`'s follow use.
   *
   * IMPORTANT: in-app plus push. QueerPulse sends no email and never will, so
   * nothing about this type may be described as one.
   *
   * See migration `AddEventAnnouncementNotificationType1794702000000`.
   */
  EventAnnouncement = 'event_announcement',

  // --- Member motions (GOV-01) ---------------------------------------------
  //
  // A member-filed governance motion gathers co-signatures, then goes to
  // platform staff for screening, then either gets a voting window or a
  // reasoned refusal. All three values are appended to
  // `notifications_type_enum` by migration
  // `AddGovernanceMemberMotions1794780000000`.

  /**
   * Sent to PLATFORM STAFF (`users.role` of `moderator` or `admin`) the moment
   * a motion's co-signature threshold is reached and it moves to `screening`,
   * so a motion ten members put their names to reaches the queue the same day
   * rather than whenever somebody next opens the console.
   *
   * Deliberately carries NO actor id: this is an operational alert, and the
   * `actorId` argument of `NotificationsService.createForRecipients` applies
   * the recipient's own block/mute list. A staff duty alert must not be
   * droppable because a moderator once muted the member who happened to cast
   * the tenth signature.
   *
   * Payload: `{ source: 'governance', proposalId, title, cosignatureCount }`.
   */
  GovernanceMotionReadyForReview = 'governance_motion_ready_for_review',

  /**
   * Sent to the member who FILED the motion when an admin approves it and sets
   * its voting window. System-driven, no actor: the proposer is owed the
   * decision, not the name of the admin who signed off on it.
   *
   * Payload: `{ source: 'governance', proposalId, title, opensAt, closesAt,
   * note? }`.
   */
  GovernanceMotionApproved = 'governance_motion_approved',

  /**
   * Sent to the member who FILED the motion when an admin declines to put it
   * to a vote. System-driven, no actor, same reasoning as the approval.
   *
   * The `note` is REQUIRED on a rejection (see `RejectGovernanceMotionDto`)
   * and rides along in the payload: a motion declined without a word is
   * exactly the opaque decision this module exists to rule out.
   *
   * Payload: `{ source: 'governance', proposalId, title, note }`.
   */
  GovernanceMotionRejected = 'governance_motion_rejected',

  /**
   * Sent to a card HOLDER thirty days before their membership card expires
   * (SUS-07). Emitted by `CardExpiryWarningService`, a daily cron in the
   * membership-cards module.
   *
   * The gap it closes: a card expires on the programme's `validityMonths`
   * clock and nothing said so. The only route back in date was an owner
   * remembering to run the roster bulk issue, so members found out their card
   * was dead standing at a door.
   *
   * Fires ONCE per term. The daily tick is what makes that the hard part, so
   * the row is CLAIMED with a conditional UPDATE on
   * `membership_cards.expiry_warning_sent_at`, the same shape
   * `deletion_request.final_warning_sent_at` uses, and every path that puts the
   * card back in date clears the marker so the NEXT term earns its own warning.
   *
   * System-driven: no actor, and no `NotificationPreferenceCategory`. A
   * credential running out is not content volume, and there is no other channel
   * it arrives on. QueerPulse sends no email, so nothing about this type may be
   * described as one.
   *
   * Payload carries `{ source: 'card', communitySlug, communityName,
   * daysRemaining, canSelfRenew }`. `daysRemaining` is a NUMBER, which the
   * frontend mirrors onto `count` for CLDR pluralisation, exactly like
   * `AccountDeletionFinalWarning`. `canSelfRenew` is the programme's
   * `allows_self_renew` read at send time, so the copy either points at the
   * member's own Renew button or tells them their community issues the new
   * card. `source: 'card'` deep-links to /account/cards. See migration
   * `AddCardSelfRenewAndExpiryWarning1795620000000`.
   */
  CardExpiring = 'card_expiring',
}

@Entity('notifications')
@Index('IDX_notifications_user_id_created_at', ['userId', 'createdAt'])
@Index('IDX_notifications_user_id_read', ['userId', 'read'])
// Serves the bundle lookup on every notification write: "does this recipient
// already have an unread row for this subject?". Partial, because only unread
// bundling rows can ever absorb anything, which keeps the index a small
// fraction of the table.
@Index('IDX_notifications_bundle', ['userId', 'bundleKey'], {
  where: '"bundle_key" IS NOT NULL AND "read" = false',
})
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

  /**
   * The subject this row collapses same-subject events onto, or `null` for a
   * type that never bundles. See `notification-bundling.ts` for which types
   * bundle and why the key identifies the subject rather than the actor.
   */
  @Column({ type: 'varchar', length: 200, nullable: true })
  bundleKey!: string | null;

  /**
   * How many FURTHER members did the same thing to the same subject after this
   * row was written. Zero on an ordinary row, so "Ana replied" and "Ana and 39
   * others replied" are the same row shape with a different count. The actor in
   * `payload` is always the most recent one, which is why the copy names them.
   */
  @Column({ type: 'int', default: 0 })
  otherActorCount!: number;

  /**
   * Set on insert, and bumped again every time this row absorbs another event,
   * so a bundle returns to the top of the feed as it grows. The feed orders on
   * this column, so it has to move; the first event's time is not kept, because
   * "when did this conversation last happen" is the useful fact and the one the
   * row's relative timestamp claims to show.
   */
  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;
}
