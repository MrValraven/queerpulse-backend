import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { EventOrganizerView, toOrganizerView } from './event-response';
import { EventInvite, EventInviteStatus } from './entities/event-invite.entity';
import { Event } from './entities/event.entity';

// The event fields an invitee needs to decide whether to accept/decline. Kept
// deliberately lean (no description/onlineUrl) — the invitee opens the full
// detail via GET /events/:slug once they act.
export interface InvitedEventView {
  slug: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  timezone: string;
  venue: string | null;
  isOnline: boolean;
  coverImageUrl: string | null;
  status: string;
  visibility: string;
}

// One row of GET /event-invites: the invite id (so the client can call
// PATCH /event-invites/:id), the event it points at, and who invited them.
export interface PendingEventInviteView {
  id: string;
  status: EventInviteStatus;
  createdAt: Date;
  event: InvitedEventView | null;
  inviter: EventOrganizerView | null;
}

function toInvitedEventView(e: Event): InvitedEventView {
  return {
    slug: e.slug,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    timezone: e.timezone,
    venue: e.venue,
    isOnline: e.isOnline,
    coverImageUrl: toImageUrl(e.coverImageUrl),
    status: e.status,
    visibility: e.visibility,
  };
}

export function toPendingEventInviteView(
  invite: EventInvite,
  event: Event | null,
  inviter: Profile | undefined,
): PendingEventInviteView {
  return {
    id: invite.id,
    status: invite.status,
    createdAt: invite.createdAt,
    event: event ? toInvitedEventView(event) : null,
    inviter: toOrganizerView(inviter),
  };
}
