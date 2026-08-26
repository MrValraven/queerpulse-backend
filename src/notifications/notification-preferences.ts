import { NotificationType } from './entities/notification.entity';

/**
 * The member-facing preference categories, one per genuinely-backed toggle row
 * in the frontend's Notifications settings pane. A category groups every
 * `NotificationType` that the same toggle should silence, so the UI stays a
 * short list of intent ("gathering invites", "replies to my threads") while the
 * write path can gate any number of concrete types behind it.
 *
 * Stored as a plain string (not a Postgres enum): adding a category is then a
 * code-only change with no `ALTER TYPE` migration, and the value never has to
 * round-trip through a DB enum the way `NotificationType` does. The DTO's
 * `@IsIn(NOTIFICATION_PREFERENCE_CATEGORIES)` is the write-time guard instead.
 */
export enum NotificationPreferenceCategory {
  /** "New gathering announced" — you were invited to an event. */
  EventInvites = 'event_invites',
  /** "RSVP reminder" — the lead-time reminder before an event you're attending. */
  EventReminders = 'event_reminders',
  /** "Someone RSVP'd" / "co-host invite" — activity on gatherings you run. */
  EventActivity = 'event_activity',
  /** "New message" — a new direct message (delivered as push only, see below). */
  NewMessages = 'new_messages',
  /** "Connection request" — someone asked to connect, or accepted your request. */
  Connections = 'connections',
  /** "Reply to a thread I'm in" — forum/community replies. */
  CommunityReplies = 'community_replies',
  /** "New post in a community" — ordinary posts and shared resources. */
  CommunityPosts = 'community_posts',
  /** "Community announcements" — what an owner or mod marked as one. */
  CommunityAnnouncements = 'community_announcements',
  /** "Topics I follow" — a new post under a topic you follow. */
  TopicFollows = 'topic_follows',
  /** "Mentions" — someone @-mentioned you in a post or discussion. */
  Mentions = 'mentions',
  /** "Vouches" — someone vouched for you, or for a space you own. */
  Vouches = 'vouches',
  /** "Recognition" — XP, badges, endorsements, credits, new followers. */
  Recognition = 'recognition',
  /** "Personas" — invitations to co-own a persona and who joined one. */
  Personas = 'personas',
  /** "Invitations and introductions" — invites accepted, intros made. */
  Invitations = 'invitations',
  /** "Listings I manage" — questions, accepted edits, co-manager invites. */
  Listings = 'listings',
  /** "Opportunities" — job/volunteer applications, swaps, housing matches. */
  Opportunities = 'opportunities',
  /** "The magazine" — desk messages and a shipped issue. */
  Magazine = 'magazine',
}

/** Every category, in the order the settings pane lists them. */
export const NOTIFICATION_PREFERENCE_CATEGORIES = Object.values(
  NotificationPreferenceCategory,
);

/**
 * Which categories the member may toggle. Both channels default ON, so a member
 * who never opens settings keeps every notification exactly as before.
 */
export const DEFAULT_PREFERENCE_ENABLED = true;

/**
 * Maps a concrete `NotificationType` to the toggle that governs it. A type that
 * is ABSENT here has no member switch and is always delivered.
 *
 * The absent set is not an accident: see `ALWAYS_DELIVERED_NOTIFICATION_TYPES`
 * below, which names the unmutable types and the reason each one stays that way.
 * Every type a member could reasonably describe as noise now sits behind one of
 * the categories above, so turning the volume down never means leaving a
 * community; what is left unmutable is safety, account lifecycle, governance,
 * and the outcome of something the member themself asked for.
 *
 * Deliberately a `Partial`, not a total `Record`: a type added tomorrow that
 * nobody has classified yet must keep being delivered rather than fail the
 * build, and classification is a follow-up edit here plus a line in the list
 * below.
 *
 * `NewMessage` is listed so its category exists for the push path, even though
 * no in-app `new_message` row is ever written in live mode (the Messages inbox
 * is that surface); the push listener is where this category actually bites.
 */
export const NOTIFICATION_TYPE_CATEGORY: Partial<
  Record<NotificationType, NotificationPreferenceCategory>
> = {
  // --- Gatherings -----------------------------------------------------------
  [NotificationType.EventInvite]: NotificationPreferenceCategory.EventInvites,
  [NotificationType.EventReminder]:
    NotificationPreferenceCategory.EventReminders,
  [NotificationType.EventRsvp]: NotificationPreferenceCategory.EventActivity,
  [NotificationType.EventCohostInvite]:
    NotificationPreferenceCategory.EventActivity,

  // --- Messages and connections --------------------------------------------
  [NotificationType.NewMessage]: NotificationPreferenceCategory.NewMessages,
  [NotificationType.ConnectionRequest]:
    NotificationPreferenceCategory.Connections,
  [NotificationType.ConnectionAccepted]:
    NotificationPreferenceCategory.Connections,

  // --- Discussion -----------------------------------------------------------
  [NotificationType.ForumReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.ForumThreadReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.CommunityReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.CommunityNewPost]:
    NotificationPreferenceCategory.CommunityPosts,
  [NotificationType.CommunityResourceAdded]:
    NotificationPreferenceCategory.CommunityPosts,
  [NotificationType.CommunityAnnouncement]:
    NotificationPreferenceCategory.CommunityAnnouncements,
  [NotificationType.TopicNewPost]: NotificationPreferenceCategory.TopicFollows,
  [NotificationType.Mention]: NotificationPreferenceCategory.Mentions,

  // --- Trust ----------------------------------------------------------------
  [NotificationType.VouchReceived]: NotificationPreferenceCategory.Vouches,
  // A safe-space vouch is a vouch: the same member-facing toggle governs both.
  [NotificationType.SafeSpaceVouch]: NotificationPreferenceCategory.Vouches,

  // --- Recognition ----------------------------------------------------------
  [NotificationType.XpLevelUp]: NotificationPreferenceCategory.Recognition,
  [NotificationType.BadgeEarned]: NotificationPreferenceCategory.Recognition,
  [NotificationType.PersonaEndorsed]:
    NotificationPreferenceCategory.Recognition,
  [NotificationType.PersonaFollowed]:
    NotificationPreferenceCategory.Recognition,
  [NotificationType.SubprofileCredit]:
    NotificationPreferenceCategory.Recognition,

  // --- Personas -------------------------------------------------------------
  [NotificationType.SubprofileInvite]: NotificationPreferenceCategory.Personas,
  [NotificationType.SubprofileCoOwnerJoined]:
    NotificationPreferenceCategory.Personas,

  // --- Invitations and introductions ----------------------------------------
  [NotificationType.InviteAccepted]: NotificationPreferenceCategory.Invitations,
  [NotificationType.IntroductionMade]:
    NotificationPreferenceCategory.Invitations,
  [NotificationType.CommunityInviteReceived]:
    NotificationPreferenceCategory.Invitations,

  // --- Listings you manage --------------------------------------------------
  [NotificationType.ListingPublicQuestion]:
    NotificationPreferenceCategory.Listings,
  [NotificationType.ListingPublicQuestionAnswered]:
    NotificationPreferenceCategory.Listings,
  [NotificationType.ListingEditSuggestionAccepted]:
    NotificationPreferenceCategory.Listings,
  [NotificationType.ListingCoManagerInvite]:
    NotificationPreferenceCategory.Listings,
  [NotificationType.ListingCoManagerInviteAccepted]:
    NotificationPreferenceCategory.Listings,
  [NotificationType.ListingCoManagerInviteDeclined]:
    NotificationPreferenceCategory.Listings,

  // --- Opportunities --------------------------------------------------------
  [NotificationType.JobApplication]:
    NotificationPreferenceCategory.Opportunities,
  [NotificationType.VolunteerApplicationReceived]:
    NotificationPreferenceCategory.Opportunities,
  [NotificationType.BarterProposalReceived]:
    NotificationPreferenceCategory.Opportunities,
  [NotificationType.HousingListingMatch]:
    NotificationPreferenceCategory.Opportunities,

  // --- The magazine ---------------------------------------------------------
  [NotificationType.MagazinePieceMessage]:
    NotificationPreferenceCategory.Magazine,
  [NotificationType.MagazineIssuePublished]:
    NotificationPreferenceCategory.Magazine,
};

/**
 * The `NotificationType`s that deliberately have NO member switch, grouped by
 * the reason. This list is documentation with teeth: it is the answer to "what
 * can this platform still put in front of me that I did not ask for?", and
 * `notification-preferences.spec.ts` asserts that nothing appears both here and
 * in `NOTIFICATION_TYPE_CATEGORY`, so a type can never be classified twice.
 *
 * A type in NEITHER place is still always delivered (see the map above). That is
 * the safe default for a decision or outcome type added after this list was
 * written, and the reason the two are not asserted to be exhaustive together.
 *
 * Four reasons, and nothing else qualifies:
 *  1. **Safety and moderation.** A moderation outcome, an appeal or report
 *     result, a ban, a security sign-in alert. The platform's word about what
 *     happened to you, always delivered.
 *  2. **Account lifecycle.** An export that is ready to download, a deletion
 *     about to finalise, promotion to full member. Time-bounded, and
 *     irreversible if missed.
 *  3. **Governance of something you belong to or run.** Your role changed, the
 *     community was archived, frozen or handed to someone else, you were removed
 *     from a roster or a shared persona.
 *  4. **A decision on something you asked for.** An application, claim,
 *     nomination or join request that was approved or declined, or a gathering
 *     you are attending that moved or was cancelled.
 */
export const ALWAYS_DELIVERED_NOTIFICATION_TYPES: readonly NotificationType[] =
  [
    // 1. Safety and moderation.
    NotificationType.ModerationOutcome,
    NotificationType.ReportFiled,
    NotificationType.CommunityReportFiled,
    NotificationType.ReportResolved,
    NotificationType.AppealResolved,
    NotificationType.CommunityBanned,
    NotificationType.ConcernUpdate,
    NotificationType.SecurityNewSignIn,
    // A moderation queue crossing its warning or critical threshold, and its
    // recovery notice (TS-04). Reaches platform `moderator`/`admin` accounts
    // only (a member can never receive one), and it is duty mail about the
    // platform's own published review windows. A volume control that could
    // silence it would defeat the only thing it exists to do, and the alert is
    // already deduplicated at source (one per queue per state change, not one
    // per hourly tick), so there is no volume here for a switch to control.
    NotificationType.ModerationQueueAlert,

    // 2. Account lifecycle.
    NotificationType.PromotedToMember,
    NotificationType.VerificationUpdate,
    NotificationType.AccountExportReady,
    NotificationType.AccountDeletionFinalWarning,
    // An operator's decision on a statutory data right. It carries the member's
    // own case reference and there is no other channel it arrives on, so it is
    // not something a volume control may swallow.
    NotificationType.DsarResolved,
    // A membership card thirty days from expiry (SUS-07). Time-bounded and
    // irreversible if missed in the plainest sense this list has: miss it and
    // the card stops working at a door, in front of people. It arrives once per
    // term, so there is no volume for a switch to control.
    NotificationType.CardExpiring,

    // 3. Governance of a community or persona you belong to.
    NotificationType.CommunityRoleChanged,
    NotificationType.CommunityMemberRemoved,
    NotificationType.CommunityOwnershipTransferred,
    NotificationType.CommunityArchived,
    NotificationType.CommunityFrozen,
    NotificationType.CommunityUnfrozen,
    NotificationType.CommunityOwnerReviewRequested,
    NotificationType.CommunityTagRequestResolved,
    // Platform staff offering a community that is struggling some help
    // (OPS-05). It reaches only the people running the room, it arrives at
    // most once until they answer it, and it is the platform reaching out
    // rather than community chatter, so there is no volume here for a switch
    // to control.
    NotificationType.CommunitySupportOffered,
    NotificationType.SubprofileDeleted,
    NotificationType.SubprofileMemberRemoved,

    // 4. A decision on something you asked for, or a gathering that changed.
    NotificationType.EventUpdated,
    NotificationType.EventCancelled,
    NotificationType.WaitlistPromoted,
    NotificationType.JoinRequestReceived,
    NotificationType.JoinRequestApproved,
    NotificationType.JoinRequestDeclined,
    NotificationType.ListingApproved,
    NotificationType.ListingReview,
    NotificationType.ListingClaimApproved,
    NotificationType.ListingClaimDeclined,
    NotificationType.WriterApplicationApproved,
    NotificationType.WriterApplicationDeclined,
    NotificationType.VolunteerApplicationDecided,
    NotificationType.ChangemakerNominationApproved,
    NotificationType.ChangemakerNominationDismissed,
    NotificationType.RoadmapStatus,
    // The outcome of any non-concern intake form the member filled in, split off
    // from `ConcernUpdate` above so the copy names the form rather than calling
    // everything a concern. Same reasoning as `ConcernUpdate`: a decision on
    // something you personally sent in is always delivered.
    NotificationType.IntakeReviewed,
  ];

/** The category a type belongs to, or `null` when it has no member switch. */
export function categoryForType(
  type: NotificationType,
): NotificationPreferenceCategory | null {
  return NOTIFICATION_TYPE_CATEGORY[type] ?? null;
}

/** One category's per-channel state, as served to and accepted from the client. */
export interface NotificationPreferenceState {
  inApp: boolean;
  push: boolean;
}

/**
 * The full preference map: every category with its effective state (a category
 * with no stored override reports the default ON for both channels). Mirrors the
 * entity by hand — there is no global serializer (see the API-response-mapping
 * notes), and the raw row's `userId`/timestamps are never leaked.
 */
export interface NotificationPreferencesResponse {
  preferences: Record<string, NotificationPreferenceState>;
}
