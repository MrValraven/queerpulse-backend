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
};

/** The acting member's user id for a notification, or `null` when its type
 *  carries no actor (or the payload is missing the expected id). */
export function actorIdOf(notification: Notification): string | null {
  const key = ACTOR_PAYLOAD_KEY[notification.type];
  if (!key) return null;
  const value = notification.payload?.[key];
  return typeof value === 'string' ? value : null;
}

export function toNotificationResponse(
  notification: Notification,
  actorProfile: Profile | undefined,
): NotificationResponse {
  return {
    id: notification.id,
    userId: notification.userId,
    type: notification.type,
    payload: notification.payload,
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
