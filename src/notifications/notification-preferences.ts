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
  /** "New message" — a new direct message (delivered as push only, see below). */
  NewMessages = 'new_messages',
  /** "Connection request" — someone asked to connect, or accepted your request. */
  Connections = 'connections',
  /** "Reply to a thread I'm in" — forum/community replies. */
  CommunityReplies = 'community_replies',
  /** "Mentions" — someone @-mentioned you in a post or discussion. */
  Mentions = 'mentions',
  /** "Vouches" — someone vouched for you. */
  Vouches = 'vouches',
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
 * is ABSENT here has no member switch and is always delivered — this is
 * deliberate for safety/system notifications the member must not be able to mute
 * (moderation outcomes, appeal/report results, promotion, join-request results,
 * listing approvals, roadmap status), matching how the settings pane offers no
 * toggle for them.
 *
 * `NewMessage` is listed so its category exists for the push path, even though
 * no in-app `new_message` row is ever written in live mode (the Messages inbox
 * is that surface); the push listener is where this category actually bites.
 */
export const NOTIFICATION_TYPE_CATEGORY: Partial<
  Record<NotificationType, NotificationPreferenceCategory>
> = {
  [NotificationType.EventInvite]: NotificationPreferenceCategory.EventInvites,
  [NotificationType.EventReminder]:
    NotificationPreferenceCategory.EventReminders,
  [NotificationType.NewMessage]: NotificationPreferenceCategory.NewMessages,
  [NotificationType.ConnectionRequest]:
    NotificationPreferenceCategory.Connections,
  [NotificationType.ConnectionAccepted]:
    NotificationPreferenceCategory.Connections,
  [NotificationType.ForumReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.ForumThreadReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.CommunityReply]:
    NotificationPreferenceCategory.CommunityReplies,
  [NotificationType.Mention]: NotificationPreferenceCategory.Mentions,
  [NotificationType.VouchReceived]: NotificationPreferenceCategory.Vouches,
  // A safe-space vouch is a vouch — same member-facing "Vouches" toggle governs
  // both channels (the push listener is where this gate actually bites).
  [NotificationType.SafeSpaceVouch]: NotificationPreferenceCategory.Vouches,
};

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
