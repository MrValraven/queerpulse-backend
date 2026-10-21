import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import { EventOrganizerView, toOrganizerView } from './event-response';
import {
  EventInvite,
  EventInviteStatus,
  OPEN_MEMBER_INVITE_STATUSES,
} from './entities/event-invite.entity';
import {
  RsvpDetailsVisibility,
  RsvpStatus,
} from './entities/event-rsvp.entity';
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

/**
 * What a member inviter reads about one of their own invites. Computed on the
 * server so the raw invite and RSVP statuses never reach the inviter: a
 * decline, a `justMe` answer, a maybe and a cancelled RSVP all read
 * `answered`, so the inviter cannot tell which way the invitee went.
 */
export type InviterInviteStatus =
  | 'invited'
  | 'awaiting_host'
  | 'host_declined'
  | 'going'
  | 'waitlisted'
  | 'answered';

/** One row of GET /events/:slug/rsvp/invites, the caller's own member invites. */
export interface InviterInviteView {
  id: string;
  invitee: EventOrganizerView | null;
  status: InviterInviteStatus;
  createdAt: Date;
  canWithdraw: boolean;
}

/** One row of GET /events/:slug/invite-requests. ORGANISERS ONLY: it names the inviter. */
export interface InviteRequestView {
  id: string;
  inviter: EventOrganizerView | null;
  invitee: EventOrganizerView | null;
  createdAt: Date;
}

export type MemberInviteRefusalReason = 'already_invited' | 'not_invitable';

/** The answer to POST /events/:slug/rsvp/invites. */
export interface CreateMemberInvitesResult {
  invites: InviterInviteView[];
  refused: { slug: string; reason: MemberInviteRefusalReason }[];
}

/** The invitee's RSVP fields `inviterFacingStatus` reads. */
export interface InviteeRsvpFacts {
  status: RsvpStatus;
  visibility: RsvpDetailsVisibility | null;
}

/**
 * The status a member inviter sees for one invite (spec decision 7). Going or
 * waitlisted shows only when the invitee lets the inviter see it: visibility
 * `everyone` (a NULL visibility reads as everyone) or `connections` while the
 * two are connected. Everything else an invitee answered reads `answered`.
 * Returns null for a withdrawn invite, which is never listed.
 */
export function inviterFacingStatus(
  inviteStatus: EventInviteStatus,
  inviteeRsvp: InviteeRsvpFacts | null,
  isInviterConnected: boolean,
): InviterInviteStatus | null {
  switch (inviteStatus) {
    case EventInviteStatus.Pending:
      return 'invited';
    case EventInviteStatus.AwaitingHost:
      return 'awaiting_host';
    case EventInviteStatus.HostDeclined:
      return 'host_declined';
    case EventInviteStatus.Withdrawn:
      return null;
    case EventInviteStatus.Declined:
      return 'answered';
    case EventInviteStatus.Accepted:
      break;
  }
  if (
    !inviteeRsvp ||
    (inviteeRsvp.status !== RsvpStatus.Going &&
      inviteeRsvp.status !== RsvpStatus.Waitlisted)
  ) {
    return 'answered';
  }
  const visibility = inviteeRsvp.visibility ?? 'everyone';
  const isVisibleToInviter =
    visibility === 'everyone' ||
    (visibility === 'connections' && isInviterConnected);
  if (!isVisibleToInviter) {
    return 'answered';
  }
  return inviteeRsvp.status === RsvpStatus.Going ? 'going' : 'waitlisted';
}

export function toInviterInviteView(
  invite: EventInvite,
  status: InviterInviteStatus,
  invitee: Profile | undefined,
): InviterInviteView {
  return {
    id: invite.id,
    invitee: toOrganizerView(invitee),
    status,
    createdAt: invite.createdAt,
    canWithdraw: OPEN_MEMBER_INVITE_STATUSES.includes(invite.status),
  };
}

export function toInviteRequestView(
  invite: EventInvite,
  inviter: Profile | undefined,
  invitee: Profile | undefined,
): InviteRequestView {
  return {
    id: invite.id,
    inviter: toOrganizerView(inviter),
    invitee: toOrganizerView(invitee),
    createdAt: invite.createdAt,
  };
}
