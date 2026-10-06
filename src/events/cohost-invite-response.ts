import { toImageUrl } from '../common/image-url';
import { Profile } from '../users/entities/profile.entity';
import {
  EventCohostInvite,
  EventCohostInviteStatus,
} from './entities/event-cohost-invite.entity';
import { Event } from './entities/event.entity';

export interface CohostInviteEventSummaryView {
  slug: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  timezone: string;
  venue: string | null;
  isOnline: boolean;
  /** Null when the host hid the attendee count and the viewer is not an
   *  organiser (`areAttendeeCountsWithheld`). An invitee is not an organiser
   *  until they accept, and can still read the invite after it closes. */
  goingCount: number | null;
  waitlistCount: number | null;
}

export interface CohostInviteInviterView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  hostedEventsCount: number;
  mutualConnectionsCount: number;
}

export interface CohostInviteDetailView {
  id: string;
  status: EventCohostInviteStatus;
  role: string;
  commitment: string;
  message: string | null;
  replyByDate: Date | null;
  createdAt: Date;
  event: CohostInviteEventSummaryView;
  inviter: CohostInviteInviterView;
}

export function toCohostInviteEventSummaryView(
  event: Event,
  goingCount: number | null,
  waitlistCount: number | null,
): CohostInviteEventSummaryView {
  return {
    slug: event.slug,
    title: event.title,
    startAt: event.startAt,
    endAt: event.endAt,
    timezone: event.timezone,
    venue: event.venue,
    isOnline: event.isOnline,
    goingCount,
    waitlistCount,
  };
}

export function toCohostInviteInviterView(
  inviter: Profile,
  hostedEventsCount: number,
  mutualConnectionsCount: number,
): CohostInviteInviterView {
  return {
    slug: inviter.slug,
    firstName: inviter.firstName,
    lastName: inviter.lastName,
    avatarUrl: toImageUrl(inviter.avatarUrl),
    hostedEventsCount,
    mutualConnectionsCount,
  };
}

export function toCohostInviteDetailView(
  invite: EventCohostInvite,
  event: Event,
  inviter: Profile,
  goingCount: number | null,
  waitlistCount: number | null,
  hostedEventsCount: number,
  mutualConnectionsCount: number,
): CohostInviteDetailView {
  return {
    id: invite.id,
    status: invite.status,
    role: invite.role,
    commitment: invite.commitment,
    message: invite.message,
    replyByDate: invite.replyByDate,
    createdAt: invite.createdAt,
    event: toCohostInviteEventSummaryView(event, goingCount, waitlistCount),
    inviter: toCohostInviteInviterView(
      inviter,
      hostedEventsCount,
      mutualConnectionsCount,
    ),
  };
}
