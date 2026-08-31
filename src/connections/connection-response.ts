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
 * The per-tab totals for the connections page badges, keyed by the same `tab`
 * values the list endpoint accepts — minus "blocked", which the blocks resource
 * owns — so each count lines up with the list it summarizes.
 */
export interface ConnectionCounts {
  all: number;
  incoming: number;
  outgoing: number;
  vouched: number;
}

/**
 * One pending request the viewer has been sent, reduced to the two facts a
 * profile hero needs: whose profile it is on, and which connection to answer.
 * The id is what `PATCH /connections/:id` accepts, so the hero can accept or
 * decline without first loading the connections page.
 */
export interface IncomingConnectionRef {
  slug: string;
  connectionId: string;
}

/**
 * Every relationship the viewer holds with another member, as bare slugs: who
 * they are connected to, who has asked them, and who they have asked.
 *
 * ONE request for all three (PRD-03). The client used to fetch only the
 * accepted slugs, so a member looking at the profile of somebody who had
 * ALREADY asked to connect with them was still offered "Say hello", and
 * sending it was refused with a 409. Nothing on the client could know better,
 * because nothing on the client had ever been told. Fetching this per profile
 * view would be a request per card on every members grid, so it is one
 * session-scoped call the whole app reads.
 */
export interface ConnectionRelationshipSlugs {
  connected: string[];
  incoming: IncomingConnectionRef[];
  sent: string[];
}

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
  /**
   * Whether the VIEWER is the one who sent this request. Once a connection is
   * accepted, `direction` collapses to "connected" and the request's own words
   * lose their author, so the card cannot tell "you reached out about
   * collaborating" from "they did" without this.
   *
   * `requestMessage` / `requestReason` stay visible to both parties, which is
   * what the request flow implies: the requester chose them, the addressee is
   * who they were written for, and nobody else is ever in a connection.
   */
  isRequestedByYou: boolean;
  /**
   * The VIEWER'S OWN private note about this connection, or null when they have
   * not written one. Never the other party's note: the loader that fills this
   * only ever reads rows whose `authorId` is the viewer, so a note belonging to
   * anyone else is not in memory to be mapped here.
   */
  note: string | null;
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
  // The viewer's own note, already filtered to `authorId = viewerUserId` by the
  // caller. Optional so the single-connection create path (which has no note by
  // definition) needs no extra argument.
  viewerNote?: string | null,
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
    isRequestedByYou: conn.requesterId === viewerUserId,
    note: viewerNote ?? null,
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
