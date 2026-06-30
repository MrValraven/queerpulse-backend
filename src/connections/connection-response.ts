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

export interface ConnectionListItem {
  id: string;
  status: ConnectionStatus;
  direction: 'incoming' | 'outgoing' | 'connected';
  requestMessage: string | null;
  createdAt: Date;
  respondedAt: Date | null;
  member: ConnectionMemberView;
}

export function toConnectionListItem(
  conn: Connection,
  viewerUserId: string,
  otherProfile: Profile | undefined,
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
    createdAt: conn.createdAt,
    respondedAt: conn.respondedAt,
    member: {
      slug: otherProfile?.slug ?? '',
      firstName: otherProfile?.firstName ?? '',
      lastName: otherProfile?.lastName ?? '',
      avatarUrl: otherProfile?.avatarUrl ?? null,
      pronouns: otherProfile?.pronouns ?? null,
      tagline: otherProfile?.tagline ?? null,
    },
  };
}
