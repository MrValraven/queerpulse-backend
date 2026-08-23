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
  [NotificationType.SubprofileInvite]: 'invitedByUserId',
  [NotificationType.SubprofileCoOwnerJoined]: 'joinedUserId',
  [NotificationType.MagazinePieceMessage]: 'authorId',
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
    [NotificationType.Mention]: ['entityKind', 'entityRef'],
    [NotificationType.ForumReply]: ['threadTitle'],
    [NotificationType.ForumThreadReply]: ['threadTitle'],
    [NotificationType.TopicNewPost]: ['topicSlug', 'topicLabel', 'threadTitle'],
    [NotificationType.ModerationOutcome]: ['action', 'note'],
    [NotificationType.ConcernUpdate]: ['status', 'category'],
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
    [NotificationType.BadgeEarned]: ['badgeName'],
    [NotificationType.SubprofileCredit]: [
      'subprofileName',
      'subprofileSlugOrHandle',
      'itemTitle',
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
    [NotificationType.ListingEditSuggestionAccepted]: ['field'],
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
    [NotificationType.CommunityBanned]: ['communityName'],
    // The resource's own title, which is owner-authored and already public on
    // the community's shelf to anyone who can see this notification.
    [NotificationType.CommunityResourceAdded]: ['communityName', 'title'],
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
