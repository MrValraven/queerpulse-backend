import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { Connection, ConnectionStatus } from './entities/connection.entity';

export interface ConnectionMemberView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  pronouns: string | null;
  tagline: string | null;
}

/** How the viewer and the other member have vouched for each other, if at all. */
export type VouchBadge = 'vouched-for-you' | 'you-vouched' | 'mutual';

/**
 * The viewer-relative relationship signals a card shows beyond the raw
 * connection: how many accepted connections the two share, and the vouch
 * relationship between them. Computed per-viewer, so they live outside the
 * connection entity.
 */
export interface ConnectionRelationship {
  mutuals: number;
  vouchBadge: VouchBadge | null;
}

export interface ConnectionListItem {
  id: string;
  status: ConnectionStatus;
  direction: 'incoming' | 'outgoing' | 'connected';
  requestMessage: string | null;
  requestReason: string | null;
  createdAt: Date;
  respondedAt: Date | null;
  member: ConnectionMemberView;
  // Accepted connections the viewer shares with `member`.
  mutuals: number;
  // The vouch relationship between the viewer and `member`, or null.
  vouchBadge: VouchBadge | null;
  // The mutual connection who introduced the requester (network intros only).
  introducedBy: ConnectionMemberView | null;
}

export function toConnectionListItem(
  conn: Connection,
  viewerUserId: string,
  otherProfile: Profile | undefined,
  relationship: ConnectionRelationship,
  introducerProfile?: Profile,
): ConnectionListItem {
  // From the viewer's perspective: an incoming pending request is one where the
  // viewer is the addressee; outgoing is one they sent; accepted is "connected".
  let direction: 'incoming' | 'outgoing' | 'connected';
  if (conn.status === ConnectionStatus.Pending) {
    direction = conn.addresseeId === viewerUserId ? 'incoming' : 'outgoing';
  } else {
    direction = 'connected';
  }
  return {
    id: conn.id,
    status: conn.status,
    direction,
    requestMessage: conn.requestMessage,
    requestReason: conn.requestReason,
    createdAt: conn.createdAt,
    respondedAt: conn.respondedAt,
    member: {
      slug: otherProfile?.slug ?? '',
      firstName: otherProfile?.firstName ?? '',
      lastName: otherProfile?.lastName ?? '',
      avatarUrl: toImageUrl(otherProfile?.avatarUrl),
      pronouns: otherProfile?.pronouns ?? null,
      tagline: otherProfile?.tagline ?? null,
    },
    mutuals: relationship.mutuals,
    vouchBadge: relationship.vouchBadge,
    introducedBy: introducerProfile
      ? {
          slug: introducerProfile.slug,
          firstName: introducerProfile.firstName,
          lastName: introducerProfile.lastName,
          avatarUrl: toImageUrl(introducerProfile.avatarUrl),
          pronouns: introducerProfile.pronouns ?? null,
          tagline: introducerProfile.tagline ?? null,
        }
      : null,
  };
}
