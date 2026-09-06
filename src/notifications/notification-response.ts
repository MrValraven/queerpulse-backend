import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { Notification, NotificationType } from './entities/notification.entity';

/**
 * The member whose action triggered a notification, resolved for display so the
 * bell can name and link to them (and show their avatar) instead of an
 * anonymous "someone …". `null` for system notifications (waitlist/promotion)
 * and for any row whose actor can no longer be resolved.
 */
export interface NotificationActor {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

/**
 * A notification as served to the client: the stored row plus the resolved
 * `actor`. Mirrors the entity 1:1 (there is no global serializer — every
 * endpoint hand-maps, see the API-response-mapping notes) and only adds `actor`.
 */
export interface NotificationResponse {
  id: string;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  read: boolean;
  createdAt: Date;
  actor: NotificationActor | null;
  /**
   * How many FURTHER members did the same thing to the same subject after this
   * row was written, so the client can render "Ana and 39 others replied" from
   * one row. `0` on an ordinary row. `actor` is always the most recent of them,
   * which is why the copy names them and counts the rest.
   */
  otherActorCount: number;
}

/**
 * Per-type payload key holding the acting member's user id. This is the same
 * per-type key `NotificationsListener` writes and `NotificationsService.create`
 * filters blocks on — reused here for display only.
 *
 * A missing entry (system types, or any future type) simply yields
 * `actor: null`, never an error, so the enrichment degrades gracefully. The
 * actor id in `payload` stays the source of truth: name/slug/avatar are
 * resolved fresh on every read, so a renamed member or a new avatar is never
 * stale and a changed slug never links to a dead profile.
 */
const ACTOR_PAYLOAD_KEY: Partial<Record<NotificationType, string>> = {
  [NotificationType.ConnectionRequest]: 'fromUserId',
  [NotificationType.ConnectionAccepted]: 'byUserId',
  [NotificationType.VouchReceived]: 'voucherId',
  [NotificationType.IntroductionMade]: 'requesterId',
  [NotificationType.EventInvite]: 'inviterId',
  [NotificationType.Mention]: 'actorId',
  [NotificationType.ForumReply]: 'actorId',
  // Member-driven coverage-sweep types. The system-driven ones
  // (JoinRequestApproved/Declined, ListingApproved, ReportResolved,
  // AppealResolved, RoadmapStatus) carry no actor — the platform is telling
  // you about your own status — so they are intentionally absent here and
  // resolve to `actor: null`, exactly like PromotedToMember/WaitlistPromoted.
  [NotificationType.EventRsvp]: 'actorId',
  [NotificationType.CommunityReply]: 'actorId',
  [NotificationType.ForumThreadReply]: 'actorId',
  [NotificationType.JoinRequestReceived]: 'actorId',
  [NotificationType.JobApplication]: 'actorId',
  [NotificationType.InviteAccepted]: 'actorId',
  [NotificationType.ListingReview]: 'actorId',
  // The member who asked the public question, resolved for the owner's bell.
  [NotificationType.ListingPublicQuestion]: 'actorId',
  // The listing OWNER who answered, resolved for the asker's bell, and ONLY
  // where the public listing page already links that owner's QueerPulse
  // profile. The emit site spreads `actorId` on exactly that condition
  // (`isOwnerPubliclyNamed`, the predicate the public page is built from), so a
  // MODERATOR-written answer, a CO-MANAGER's answer, and an owner on
  // `visibility: 'anon'`/`'role'` or with `linkToProfile` off all omit the key
  // entirely and yield `null` here: the row reads as the platform speaking,
  // exactly as the page attributes the answer to nobody. The block/mute gate is
  // unaffected, because the emit site passes the answering member as `create`'s
  // `actorId` argument regardless, the same split `SafeSpaceVouch` uses.
  [NotificationType.ListingPublicQuestionAnswered]: 'actorId',
  // The listing OWNER who sent the co-manager invitation, resolved for the
  // invited member's bell so the ask has a face on it.
  [NotificationType.ListingCoManagerInvite]: 'actorId',
  // The invited member, resolved for the owner's bell on their answer.
  [NotificationType.ListingCoManagerInviteAccepted]: 'actorId',
  [NotificationType.ListingCoManagerInviteDeclined]: 'actorId',
  [NotificationType.SubprofileInvite]: 'invitedByUserId',
  [NotificationType.SubprofileCoOwnerJoined]: 'joinedUserId',
  [NotificationType.MagazinePieceMessage]: 'authorId',
  // PRD-121. The EDITOR who commissioned, moved or published the piece,
  // resolved for the writer's bell so the desk has a face on it. The emit site
  // (`MagazinePieceService.notifyWriterOfPiece`) passes the same id as
  // `create`'s `actorId` argument, so block/mute filtering applies either way.
  [NotificationType.MagazinePieceCommissioned]: 'actorId',
  [NotificationType.MagazinePieceStageChanged]: 'actorId',
  [NotificationType.MagazinePiecePublished]: 'actorId',
  // The host or co-host who posted the announcement, so the bell shows
  // whose gathering just changed and who said so (LOC-06).
  [NotificationType.EventAnnouncement]: 'actorId',
  [NotificationType.VolunteerApplicationReceived]: 'actorId',
  // The voucher, resolved for the bell + push. An ANONYMOUS safe-space vouch
  // omits `voucherId` from the payload entirely (the emit site only spreads it
  // for a named vouch), so this yields `null` and the row/push read as
  // "Someone" — while the emit site still passes the voucher as the block/mute
  // `actorId` argument, keeping that safety gate intact.
  [NotificationType.SafeSpaceVouch]: 'voucherId',
  // The posting member — `TopicFollowNotificationsListener` writes this
  // alongside `topicSlug`/`topicLabel`/`threadSlug`/`threadTitle`.
  [NotificationType.TopicNewPost]: 'actorId',
  // The member proposing the swap — `BarterService.createProposal` writes this
  // alongside `barterListingId`/`listingOffer`.
  [NotificationType.BarterProposalReceived]: 'actorId',
  // PRD-48. The SUBJECT of a review who publicly answered it: the business
  // owner, the employer, the housing lister. Listed here (and `SubmissionDecided`
  // deliberately is not) because this is one member answering another member in
  // public, so it is member-driven and has to sit behind the same block/mute
  // gate `ListingPublicQuestionAnswered` sits behind. The actor is CONDITIONAL,
  // on exactly the same rule and for exactly the same reason: a MODERATOR-written
  // reply omits `actorId` from the payload entirely, and on the business
  // directory so does a CO-MANAGER's reply and an owner whose public page does
  // not link their profile. Those rows yield `null` here and read as the
  // platform speaking. The block/mute gate is unaffected in every case: the
  // notifier passes the real replier as `create`'s `actorId` argument through
  // its separate `blockGateActorId` field.
  [NotificationType.ReviewReplied]: 'actorId',
  // PRD-240. The three member-driven halves of the viewing lifecycle: the
  // requester on a request, the lister on a decision, and whoever cancelled on
  // a cancellation. Each emit site passes the same id as `create`'s `actorId`
  // argument, so block and mute apply either way.
  //
  // `HousingJoinDecided` and `HousingListingExpiring` are deliberately ABSENT:
  // the first is a staff triage decision and the bell never names which admin
  // made it (matching `HousingListingDecision`), the second is the platform
  // reporting a clock. Both yield `actor: null` and read as the platform.
  [NotificationType.HousingViewingRequested]: 'actorId',
  [NotificationType.HousingViewingDecided]: 'actorId',
  [NotificationType.HousingViewingCancelled]: 'actorId',
};

/** The acting member's user id for a notification, or `null` when its type
 *  carries no actor (or the payload is missing the expected id). */
export function actorIdOf(notification: Notification): string | null {
  const key = ACTOR_PAYLOAD_KEY[notification.type];
  if (!key) return null;
  const value = notification.payload?.[key];
  return typeof value === 'string' ? value : null;
}

/**
 * Routing + branch keys the client reads on almost every notification type:
 * `sourceHrefFromPayload` (frontend) reads `source` then one slug field to
 * build the deep-link. A type's own allowlist entry is UNIONED with these, and
 * a type with no entry forwards ONLY these — so a newly-added notification
 * type is safe-by-default (structural keys only) until someone lists the
 * display fields its copy needs.
 */
const COMMON_PAYLOAD_KEYS: readonly string[] = [
  'source',
  'threadSlug',
  'communitySlug',
  'postId',
  'eventSlug',
  'inviteId',
  'jobSlug',
  'listingSlug',
];

/**
 * The exact payload keys each notification type is rendered from on the client
 * (its i18n copy tokens + deep-link fields), UNIONED with `COMMON_PAYLOAD_KEYS`
 * at map time.
 *
 * This is the M6 fix: the notification `payload` is opaque jsonb written by
 * many listeners, and forwarding it verbatim (as `toNotificationResponse` once
 * did) shipped whatever any writer put there straight to the client. That is
 * what let a community post/reply `excerpt` — up to 140 chars of gated-space
 * body — reach a mention recipient (finding H3). Content-bearing keys
 * (`excerpt`, `body`, `text`, `message`, …) appear in NO entry here, so they
 * are dropped at this boundary for every type. Raw acting-member user ids are
 * likewise not forwarded: the actor is resolved into `actor` separately.
 */
const PAYLOAD_ALLOWLIST: Partial<Record<NotificationType, readonly string[]>> =
  {
    // PRD-15. The connection this row is about, so the bell can carry a real
    // Accept action instead of only deep-linking to a profile that (before
    // PRD-03) could not accept either. The id is already in the payload
    // `NotificationsListener.onConnectionRequested` writes; it was simply
    // stripped at this boundary, so the client had nothing to PATCH.
    //
    // Safe to forward: the recipient is the addressee of this very request, so
    // `PATCH /connections/:id` is a route they already hold. The requester's
    // own `requestMessage` is member-authored prose and appears in no entry
    // here, so it still cannot reach the bell.
    [NotificationType.ConnectionRequest]: ['connectionId'],
    // PRD-18, "last few spots". The gathering's own public title for the copy,
    // and how many seats are left. `seatsRemaining` is a NUMBER the copy is
    // CLDR-pluralised on. `source` + `eventSlug` ride in COMMON_PAYLOAD_KEYS
    // and are what the deep link is built from. Nothing about who is attending
    // rides along: a roster is read on the gathering's own page, under the
    // member's own authentication.
    [NotificationType.EventNearlyFull]: ['title', 'seatsRemaining'],
    // PRD-221. `conversationId` + `messageId` are the two ids a mention written
    // inside a DM or group thread needs to become a link to the message itself
    // (`/messages?c=<conversationId>&m=<messageId>`, the deep-link contract
    // `useMessageDeepLinks` already reads). Without them a `source: 'message'`
    // mention row could build no destination at all and opened the sender's
    // profile instead of the thing they were told about.
    //
    // Safe to forward, on the same reasoning as `ConnectionRequest`'s
    // `connectionId`: both are opaque ids the recipient already holds a route
    // to. A message mention only ever reaches a PARTICIPANT of that
    // conversation (`MentionNotificationService.recipientsAllowedForSource`
    // fails closed for a `message` source), so neither id discloses a room the
    // recipient is not already in. The message's `excerpt` stays off this wire
    // like every other content-bearing key.
    [NotificationType.Mention]: [
      'entityKind',
      'entityRef',
      'conversationId',
      'messageId',
    ],
    [NotificationType.ForumReply]: ['threadTitle'],
    [NotificationType.ForumThreadReply]: ['threadTitle'],
    [NotificationType.TopicNewPost]: ['topicSlug', 'topicLabel', 'threadTitle'],
    [NotificationType.ModerationOutcome]: ['action', 'note'],
    [NotificationType.ConcernUpdate]: ['status', 'category'],
    // The outcome of a non-concern intake form, read back to the member. Only
    // `status` (the terminal outcome the copy branches on) and `kind` (the
    // FORM's own name, a closed vocabulary from `INTAKE_KINDS`, which the copy
    // turns into "your playlist submission"). Everything the member actually
    // typed lives in the submission's opaque `payload` jsonb and appears in no
    // entry here, so none of it can reach the bell.
    [NotificationType.IntakeReviewed]: ['status', 'kind'],
    // The outcome of a data-subject request. `reference` is the member's OWN
    // case number, already shown to them on the data-request page when they
    // filed, and it is the only thing that tells one request from another. The
    // request's scope, its free-text detail and any operator note stay off this
    // wire: they are read behind the member's own authentication.
    [NotificationType.DsarResolved]: ['status', 'reference'],
    // The new-device sign-in alert (ID-06). Both fields are the copy's
    // interpolation tokens: the coarse server-composed device name, never the
    // raw User-Agent, and the ISO instant the frontend formats in the member's
    // own language. Without this entry the alert reaches the bell reading "a
    // device we don't recognise, recently", which is the fallback wording for a
    // broken payload rather than an answerable alert. `familyId` stays off the
    // wire: the deep link to /account/sessions needs no id, and a session
    // identifier is not something a bell payload has to carry.
    [NotificationType.SecurityNewSignIn]: ['deviceLabel', 'signedInAt'],
    // The countdown on a scheduled account deletion. `daysRemaining` is a
    // NUMBER and the copy is CLDR-pluralised on it, so without this entry the
    // row would forward no count and fall back to the vague flat string.
    [NotificationType.AccountDeletionFinalWarning]: ['daysRemaining'],
    // The countdown on a membership card about to expire (SUS-07).
    // `daysRemaining` is a NUMBER the copy is CLDR-pluralised on, `communityName`
    // names the issuer, and `canSelfRenew` decides between "renew it here" and
    // "your community issues the new one" — without it the bell would offer an
    // action the member's programme does not allow. The card's serial and its
    // scannable token stay off this wire: a notification payload is the wrong
    // place for a credential, and the member reads both on /account/cards under
    // their own authentication. `communitySlug` rides in COMMON_PAYLOAD_KEYS.
    [NotificationType.CardExpiring]: [
      'communityName',
      'daysRemaining',
      'canSelfRenew',
    ],
    [NotificationType.VerificationUpdate]: [
      'fromLevel',
      'toLevel',
      'requestedLevel',
      'decision',
      'reason',
    ],
    [NotificationType.EventUpdated]: ['changes', 'title'],
    [NotificationType.EventCohostInvite]: ['title'],
    [NotificationType.XpLevelUp]: ['level', 'name'],
    // `badgeKey` is the badge's stable catalogue id, the same one persisted in
    // `recognition_awards.badge_key`. The writer has always put it in the
    // payload; this allowlist dropped it, so the bell was left with only
    // `badgeName`, an English word from the backend catalogue that the client
    // had no way to translate. Forwarding the id lets the client resolve the
    // name itself and keeps `badgeName` as the fallback for an id its build
    // does not know. Neither field is content-bearing: a badge and its name
    // are the recipient's own, and already public on their badge case.
    [NotificationType.BadgeEarned]: ['badgeKey', 'badgeName'],
    [NotificationType.SubprofileCredit]: [
      'subprofileName',
      'subprofileSlugOrHandle',
      'itemTitle',
      'deepLink',
    ],
    // PRD-208, new work from a persona you follow. The persona's own public
    // name and address, the title of the newest item, and how many items
    // landed in this save (a NUMBER the copy is CLDR-pluralised on).
    //
    // `itemTitle` is the item's own heading, which is public on the persona
    // page every recipient can already open, so it discloses nothing the link
    // does not. The item's DESCRIPTION and every other body-bearing field stay
    // off this wire like all content-bearing keys. So does the persona owner's
    // identity: the fan-out passes the owner id to `createForRecipients` for
    // block/mute filtering only, `PersonaUpdate` appears under no key in
    // `ACTOR_PAYLOAD_KEY`, and an unlinked persona stays pseudonymous.
    [NotificationType.PersonaUpdate]: [
      'subprofileName',
      'subprofileSlugOrHandle',
      'itemTitle',
      'newItemCount',
      'deepLink',
    ],
    [NotificationType.SubprofileInvite]: [
      'subprofileName',
      'subprofileSlugOrHandle',
      'deepLink',
    ],
    [NotificationType.SubprofileCoOwnerJoined]: [
      'subprofileName',
      'subprofileSlugOrHandle',
      'deepLink',
    ],
    [NotificationType.SubprofileDeleted]: ['subprofileName'],
    [NotificationType.SubprofileMemberRemoved]: ['subprofileName'],
    [NotificationType.SafeSpaceVouch]: ['spaceName', 'spaceSlug'],
    [NotificationType.HousingListingMatch]: ['title', 'area', 'slug'],
    // The moderator's decision on the member's OWN housing listing, plus the
    // reason they were given. `reason` is moderator-authored prose written TO
    // this recipient (the same class of value `CommunityBanned`'s `reason` and
    // `ModerationOutcome`'s `note` already forward), never member content, and
    // it is the substance of the notification: without it the bell can only say
    // "a decision was made". `slug` carries the deep link to the listing.
    [NotificationType.HousingListingDecision]: [
      'title',
      'slug',
      'decision',
      'reason',
    ],
    // PRD-240. The housing viewing lifecycle. `slug` deep-links the listing and
    // `viewingId` the row on /local/housing/viewings; `title` is the listing's
    // own public heading, so it discloses nothing the link does not.
    //
    // The requester's MESSAGE is deliberately absent from all three: it is
    // member-authored prose written TO the recipient, the same class of value
    // kept off the bell for `ListingPublicQuestionAnswered` and `ReviewReplied`,
    // and it is already on the page this row opens.
    [NotificationType.HousingViewingRequested]: ['title', 'slug', 'viewingId'],
    // `decision` is the discriminator the frontend copy branches on:
    // `accepted` | `declined` | `proposed`.
    [NotificationType.HousingViewingDecided]: [
      'title',
      'slug',
      'viewingId',
      'decision',
    ],
    [NotificationType.HousingViewingCancelled]: ['title', 'slug', 'viewingId'],
    // PRD-242. `kind` (`coop` | `group`) picks which noun the copy uses and
    // which route the deep link builds; `decision` (`accepted` | `declined`)
    // picks the sentence. `name` is the co-op or group's public display name.
    [NotificationType.HousingJoinDecided]: [
      'kind',
      'slug',
      'name',
      'decision',
    ],
    // PRD-244. `expiresAt` is an ISO date the copy renders as a deadline. It is
    // the member's OWN listing, so nothing here is another member's data.
    [NotificationType.HousingListingExpiring]: ['title', 'slug', 'expiresAt'],
    [NotificationType.WriterApplicationApproved]: ['reviewNote'],
    [NotificationType.WriterApplicationDeclined]: ['reviewNote'],
    [NotificationType.ChangemakerNominationApproved]: [
      'nomineeName',
      'reviewNote',
    ],
    [NotificationType.ChangemakerNominationDismissed]: [
      'nomineeName',
      'reviewNote',
    ],
    [NotificationType.VolunteerApplicationReceived]: ['opportunitySlug'],
    [NotificationType.VolunteerApplicationDecided]: [
      'status',
      'opportunitySlug',
    ],
    [NotificationType.ListingReview]: ['field'],
    // The verdict on a reader's story, plus the member's OWN working title so
    // the row says which one. The decider's reply note stays off the wire here
    // on purpose: it is staff-authored prose, and the member reads it on their
    // tracker card, which they fetch under their own authentication.
    [NotificationType.StorySubmissionDecided]: ['decision', 'workingTitle'],
    // The issue-shipped announcement. `issueNumber` is both the copy token and
    // the deep-link segment (`/magazine/issue/:number`) — it rides here rather
    // than in `COMMON_PAYLOAD_KEYS` because no other type uses it. Both fields
    // are desk-authored editorial headline text that went public the instant
    // the issue shipped, so neither is content this boundary has to withhold.
    [NotificationType.MagazineIssuePublished]: ['issueNumber', 'issueTitle'],
    // PRD-121, the three writer-facing desk signals. `pieceId` is the deep
    // link (the writer's own workspace, `/magazine/writer`), `title` is the
    // piece's own working title, which the writer wrote or was commissioned
    // with and already reads on every desk surface, and `stage` is the closed
    // `PieceStage` vocabulary the copy branches on. `href` on the published
    // row is the READER path the piece just went live at, so the bell can open
    // the published piece itself.
    //
    // Nothing editorial rides along: the brief, the care record, the editor's
    // notes and the draft body all appear in no entry here, so none of them
    // can reach a bell.
    [NotificationType.MagazinePieceCommissioned]: ['pieceId', 'title'],
    [NotificationType.MagazinePieceStageChanged]: ['pieceId', 'title', 'stage'],
    [NotificationType.MagazinePiecePublished]: ['pieceId', 'title', 'href'],
    // `MagazinePieceMessage` predates the three rows above and had NO entry
    // here at all, which meant `toClientPayload` kept only COMMON_PAYLOAD_KEYS
    // and silently stripped its `pieceId`. The bell has therefore been unable
    // to link an editor-to-writer message back to its piece since that type
    // shipped, which is why the frontend rendered it as the generic unknown
    // fallback. The message BODY stays absent on purpose: it is author-written
    // prose, and this allowlist is the guarantee it can never reach a bell.
    [NotificationType.MagazinePieceMessage]: ['pieceId'],
    // The business's own public name, for copy like "someone asked a question
    // about Lux Cafe". The question BODY and the ANSWER text are deliberately
    // absent: they are member- and owner-authored prose, this allowlist is the
    // guarantee they can never reach the bell, and the deep link built from
    // `source` + `listingSlug` (both in `COMMON_PAYLOAD_KEYS`) lands the
    // recipient on the page where the words actually live.
    [NotificationType.ListingPublicQuestion]: ['listingName'],
    [NotificationType.ListingPublicQuestionAnswered]: ['listingName'],
    // The business's own public name, for copy like "Ana asked you to help
    // manage Lux Cafe". `listingSlug` and `inviteId` already ride along in
    // `COMMON_PAYLOAD_KEYS`, which is what the accept/decline deep link is
    // built from. `listingRef` is deliberately absent: it is the key to every
    // management route, and it belongs in the invite response the member
    // fetches under their own authentication, not in a bell payload.
    [NotificationType.ListingCoManagerInvite]: ['listingName'],
    [NotificationType.ListingCoManagerInviteAccepted]: ['listingName'],
    [NotificationType.ListingCoManagerInviteDeclined]: ['listingName'],
    [NotificationType.ListingEditSuggestionAccepted]: ['field'],
    // LOC-16, "a gathering has been listed at your venue". The business's own
    // public name and the gathering's own public title, which is exactly what
    // the owner needs to decide whether to confirm the attachment or detach
    // it. Both are already public on the two pages this row links between, and
    // this type is only ever raised for a PUBLISHED gathering scoped `public`
    // or `members`, so neither field can carry a private gathering's title.
    //
    // The deep link is built from `source` + `listingSlug` + `eventSlug`, all
    // three already in `COMMON_PAYLOAD_KEYS`. There is no actor entry for this
    // type in `ACTOR_PAYLOAD_KEY` above and no `actorId` in the payload: see
    // the enum member's own doc for why naming the host here would let a block
    // suppress the warning.
    [NotificationType.VenueEventAttachment]: ['listingName', 'eventTitle'],
    [NotificationType.CommunityTagRequestResolved]: ['label'],
    [NotificationType.CommunityRoleChanged]: ['communityName', 'role'],
    [NotificationType.CommunityMemberRemoved]: ['communityName'],
    [NotificationType.CommunityOwnershipTransferred]: ['communityName'],
    [NotificationType.CommunityArchived]: ['communityName'],
    [NotificationType.CommunityFrozen]: ['communityName'],
    [NotificationType.CommunityUnfrozen]: ['communityName'],
    [NotificationType.CommunityInviteReceived]: ['communityName'],
    // The community post fan-out. `postId` already rides along in
    // `COMMON_PAYLOAD_KEYS` for the deep link, so only the name is needed for
    // the copy. The writer also puts an `excerpt` in the payload and it is
    // deliberately absent here: it is member-authored post content, and this
    // allowlist is the guarantee it never reaches the bell.
    [NotificationType.CommunityNewPost]: ['communityName'],
    [NotificationType.CommunityAnnouncement]: ['communityName'],
    // Sent to the member who was barred. No actor field is listed, so the bell
    // never names the moderator who acted.
    //
    // `reason` is moderator-authored prose written TO this recipient, the same
    // class of value `HousingListingDecision.reason` forwards. `expiresAt` and
    // `ruleText` are the terms of the sanction: without them the member cannot
    // tell a week's timeout from a life ban, and cannot see which house rule
    // they are said to have broken. There is no other surface they can read any
    // of it from, because QueerPulse sends no email and the product offers no
    // way to message a community's moderators.
    [NotificationType.CommunityBanned]: [
      'communityName',
      'reason',
      'expiresAt',
      'ruleText',
      'ruleIndex',
      'ruleVersion',
    ],
    // PRD-147, to the AUTHOR of a post or reply a moderator took down. No
    // actor field is listed, so the bell never names the moderator who acted.
    //
    // `reason` is moderator-authored prose written TO this recipient, the same
    // class of value `CommunityBanned`'s `reason` forwards from a column with
    // the same posture. `ruleText`/`ruleIndex`/`ruleVersion` are the cited
    // house rule as it read at the moment of the action, and `subject`
    // (`post` | `reply`) is the closed two-value vocabulary the copy branches
    // on. Without the reason and the rule the bell can only say "something of
    // yours was removed", which is the silence this type exists to end, and
    // there is no other surface the member can read it from: QueerPulse sends
    // no email and there is no way to message a community's moderators.
    //
    // The removed content's own body is in NO payload and must never be: the
    // author is the one person who does not need it quoted back. The
    // moderators' `internalNote` is likewise absent, it stops at the
    // community's own governance log. `communitySlug` and `postId` ride in
    // COMMON_PAYLOAD_KEYS and are what the deep link is built from; a post
    // takedown deliberately writes no `postId`, so it resolves to the
    // community page rather than a blank tombstone.
    [NotificationType.CommunityPostRemoved]: [
      'communityName',
      'subject',
      'reason',
      'ruleText',
      'ruleIndex',
      'ruleVersion',
    ],
    // The resource's own title, which is owner-authored and already public on
    // the community's shelf to anyone who can see this notification.
    [NotificationType.CommunityResourceAdded]: ['communityName', 'title'],
    // Platform staff offering a community support (OPS-05). The community's
    // own name, for copy like "Someone from QueerPulse has offered Trans
    // Friends some support"; `communitySlug` already rides along in
    // `COMMON_PAYLOAD_KEYS` and is what the mod-tools deep link is built from.
    //
    // The staff member's NOTE is deliberately absent, unlike
    // `CommunityOwnerReviewRequested`'s `reason` above. That one is listed
    // because a staff alert has no other surface to be read from; this one
    // does — the offer sits in the community's own mod-tools console, fetched
    // under the moderator's own authentication, which is also where they
    // answer it. Nothing is lost by keeping the prose off the bell.
    [NotificationType.CommunitySupportOffered]: ['communityName'],
    // Platform-staff operational mail only (the write site restricts
    // recipients to Moderator/Admin). `reason` is listed on purpose, unlike
    // `BarterProposalReceived`'s `message` above: the reason IS the actionable
    // content of a staff alert, and there is no other surface a responder
    // would read it from before deciding whether to reassign the community.
    [NotificationType.CommunityOwnerReviewRequested]: [
      'communityName',
      'reason',
    ],
    // The listing id the bell deep-links to, plus the listing's OWN public
    // headline for the copy — the same kind of field as `ForumReply`'s
    // `threadTitle`. The proposal's `message` is deliberately NOT listed: it
    // is member-authored private text, it lives in the DM thread the proposal
    // also opened, and this allowlist is what guarantees it can never reach
    // the bell even if a future writer puts it in the payload.
    [NotificationType.BarterProposalReceived]: [
      'barterListingId',
      'listingOffer',
    ],
    // Staff duty mail on a newly filed report (TS-04). The write sites
    // restrict recipients to platform `Moderator`/`Admin` and to a
    // community's own owner/co-owners/mods, so these keys never reach an
    // ordinary member.
    //
    // `severity` is what the bell keys its urgent presentation off (the
    // 1-hour outing/doxxing SLA), `reasonCode` is the server-derived taxonomy
    // code the queue filters on, and `subjectType` says what kind of thing was
    // reported. `reportId` rides along so a future queue deep-link can select
    // the row.
    //
    // What is absent matters as much: the reporter's id appears in NO payload
    // (the bell never names who filed, anonymously or not) and the reporter's
    // free-text `detail` appears in none either. Both live behind the
    // moderation queue's own authentication, which is where a responder reads
    // them.
    [NotificationType.ReportFiled]: [
      'reportId',
      'severity',
      'reasonCode',
      'subjectType',
    ],
    // PRD-289. The reporter's OWN receipt for the report they just filed, so
    // the bell can name the case instead of a bare "we got it". `reference` is
    // the human-friendly code `formatReportReference` builds, which is the one
    // string a reporter can quote back; `subjectType` and `severity` let the
    // copy say what was reported and which review window it fell into.
    //
    // This is a strip-by-default boundary: a type absent from this map forwards
    // only `COMMON_PAYLOAD_KEYS`, silently, with no type error. So the entry is
    // required for the copy to interpolate at all.
    //
    // `reasonCode` is deliberately absent, unlike `ReportFiled` above. A
    // responder needs it to triage; the reporter chose it and re-stating their
    // own accusation in a bell row is not a receipt.
    [NotificationType.ReportReceived]: [
      'reportId',
      'reference',
      'subjectType',
      'severity',
    ],
    // Same fields plus the community's own public name for the copy;
    // `communitySlug` already rides along in `COMMON_PAYLOAD_KEYS` and is what
    // the mod-tools deep link is built from.
    [NotificationType.CommunityReportFiled]: [
      'reportId',
      'severity',
      'reasonCode',
      'subjectType',
      'communityName',
    ],
    // Staff duty mail on a moderation queue crossing a threshold (TS-04). The
    // write site is a cron whose recipient list is a `moderator`/`admin` role
    // query, so these keys never reach an ordinary member.
    //
    // All five are the copy's interpolation tokens: `queue` is the stable
    // `ModerationQueueKey` the client keys its own label off, `severity`
    // (`ok | warning | critical`) is what the copy and the bell's urgent
    // presentation branch on, and `depth`/`overdueCount`/`oldestItemHours` are
    // the three numbers that say what kind of trouble the queue is in.
    // `oldestItemHours` and `overdueCount` are NUMBERS, so the client can
    // CLDR-pluralise on them.
    //
    // What is absent: nothing about any individual moderator, and nothing
    // about any individual item in the queue. This alert is about a QUEUE, and
    // the row that made it deep is read behind the moderation console's own
    // authentication.
    [NotificationType.ModerationQueueAlert]: [
      'queue',
      'severity',
      'depth',
      'overdueCount',
      'oldestItemHours',
    ],
    // The queue this row is about, and nothing else. `source` rides in
    // COMMON_PAYLOAD_KEYS and is what the deep link is built from.
    //
    // `itemId` is stored on the row for correlation and is deliberately NOT
    // forwarded: the bell links to the QUEUE, and the item that landed is read
    // behind the console's own authentication. This is the same line
    // `ModerationQueueAlert` draws, for the same reason.
    [NotificationType.AdminQueueItem]: ['queue'],

    // --- The four approval queues (LOC-19) ---------------------------------
    // Each carries the `decision` its copy branches on, the member's own
    // submitted title read back to them, and the moderator's `reason` where one
    // was given. `reason` is listed for the same reason `CommunityBanned` and
    // `CommunityOwnerReviewRequested` list theirs: a refusal with no sentence
    // attached is exactly what these queues exist to stop being. Nothing else
    // the member wrote (a listing's description, price or accessibility text,
    // an intro request's note) appears in any of them.
    [NotificationType.ReadingGroupProposalDecided]: [
      'decision',
      'book',
      'communityName',
      'reason',
    ],
    [NotificationType.GroupListingDecided]: [
      'decision',
      'groupSlug',
      'groupName',
      'listingTitle',
      'reason',
    ],
    [NotificationType.LandlordSuggestionDecided]: [
      'decision',
      'landlordSlug',
      'landlordName',
      'reason',
    ],
    [NotificationType.LandlordIntroRequestDecided]: [
      'decision',
      'landlordSlug',
      'landlordName',
      'reason',
    ],
    // A community moderator handing platform staff a ban-evasion question
    // (PRD-31). The write site's recipient list is a `moderator`/`admin` role
    // query, so these keys never reach an ordinary member. `communityName` is
    // the copy's only interpolation token and `escalationId` lets the console
    // select the row; `communitySlug` and `source` ride in
    // `COMMON_PAYLOAD_KEYS`.
    //
    // What is absent is the point of the whole feature: NOTHING about the
    // applicant (no id, no name, no slug, no assessment, no tier, no score) and
    // nothing about the escalating moderator, including their free-text note.
    // Staff read all of that on `/admin/ban-evasion`, behind that console's own
    // authentication, one click from this row.
    [NotificationType.BanEvasionEscalationRaised]: [
      'escalationId',
      'communityName',
    ],
    // Staff closing that escalation, sent to the moderator who raised it and to
    // nobody else (PRD-31).
    //
    // EVERY KEY HERE IS SOMETHING THIS RECIPIENT ALREADY HOLDS from
    // `GET /communities/:slug/join-requests/escalations`, which is the test any
    // future addition has to pass. Absent, and never to be added: the
    // `resolutionNote`, the resolving staff member, the resolution timestamp,
    // and any part of the assessment (tier, score, matched signals). That is a
    // cross-community judgement, and this recipient is exactly the person
    // `CommunityBanEvasionFlagDTO` withholds it from. Widening this entry would
    // hand it to them through the bell.
    [NotificationType.BanEvasionEscalationResolved]: [
      'escalationId',
      'joinRequestId',
      'communityName',
    ],

    // --- The shared submission-decision row (PRD-48) ------------------------
    //
    // `kind` and `outcome` are the two discriminators the client branches its
    // copy on: which intake this was (`SubmissionKind`) and how it ended
    // (`SubmissionOutcome`). Both are closed, code-defined vocabularies from
    // `src/submissions/submission-kinds.ts`, never free text.
    //
    // `subjectLabel` is the submission's own headline read back to the member,
    // so the row says WHICH submission — the same class of field as
    // `StorySubmissionDecided`'s `workingTitle` and
    // `ReadingGroupProposalDecided`'s `book`. Without it a member with two
    // pending suggestions cannot tell which one was answered.
    //
    // `reviewNote` IS FORWARDED, and that was the judgement call on this entry.
    // It is REVIEWER-authored prose written TO this recipient, the same class of
    // value `WriterApplicationApproved`'s `reviewNote`, `CommunityBanned`'s
    // `reason` and all four LOC-19 queues' `reason` already forward, and never
    // member-authored content. It is forwarded because the note is the
    // SUBSTANCE of the answer and the member should be able to read it wherever
    // the answer reaches them. All three kinds also carry the same note on the
    // member's own submissions index at `/account/submissions`; carrying it in
    // both costs nothing and means the row is complete on its own, instead of
    // the reasonless refusal PRD-48 exists to stop.
    // `StorySubmissionDecided` is the counter-precedent and withholds its note
    // because that note genuinely belongs somewhere else: a full editorial
    // critique is a document rather than a notification line. That is why the
    // choice is per-kind on
    // `SUBMISSION_KIND_NOTIFICATION.isReviewNoteDelivered` rather than settled
    // once here.
    //
    // Nothing the member themself wrote into the submission body rides along:
    // their application text, their proposal message, the URL and description
    // on a suggested resource. All of it stays in the intake's own row.
    [NotificationType.SubmissionDecided]: [
      'kind',
      'outcome',
      'subjectLabel',
      'reviewNote',
    ],
    // The subject of a review answering it in public (PRD-48). `subjectLabel`
    // is the reviewed thing's own PUBLIC name (the business, the employer, the
    // home), so the row can say which review was answered; the deep link is
    // built from `source` plus a slug, both in `COMMON_PAYLOAD_KEYS`.
    //
    // THE REPLY TEXT IS DELIBERATELY ABSENT, and no future writer may add it.
    // It is subject-authored prose, and it is already published on the page one
    // click away — the identical rule that keeps
    // `ListingPublicQuestionAnswered`'s answer body off the bell. The member's
    // own review text is absent for the stronger reason that this allowlist
    // carries no member-authored content at all.
    [NotificationType.ReviewReplied]: ['subjectLabel'],
  };

/**
 * The client-safe projection of a notification's opaque `payload` jsonb: only
 * the per-type allowlisted keys (plus `COMMON_PAYLOAD_KEYS`) that are actually
 * present. Everything else — content-bearing fields like `excerpt`, raw user
 * ids, and any future field a listener adds — is stripped, so the raw blob can
 * never reach the client through `payload`. Shared by the HTTP response mapper
 * and the socket relay so both go through the same allowlist.
 */
export function toClientPayload(
  notification: Notification,
): Record<string, unknown> {
  const payload = notification.payload ?? {};
  const allowedKeys = new Set<string>([
    ...COMMON_PAYLOAD_KEYS,
    ...(PAYLOAD_ALLOWLIST[notification.type] ?? []),
  ]);
  const projected: Record<string, unknown> = {};
  for (const key of allowedKeys) {
    if (payload[key] !== undefined) {
      projected[key] = payload[key];
    }
  }
  return projected;
}

export function toNotificationResponse(
  notification: Notification,
  actorProfile: Profile | undefined,
): NotificationResponse {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    payload: toClientPayload(notification),
    read: notification.read,
    createdAt: notification.createdAt,
    otherActorCount: notification.otherActorCount ?? 0,
    actor: actorProfile
      ? {
          slug: actorProfile.slug,
          firstName: actorProfile.firstName,
          lastName: actorProfile.lastName,
          avatarUrl: toImageUrl(actorProfile.avatarUrl),
        }
      : null,
  };
}
