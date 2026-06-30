import { Profile } from '../users/entities/profile.entity';
import { Event } from './entities/event.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';

export interface EventOrganizerView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
}

export interface EventSummary {
  slug: string;
  title: string;
  startAt: Date;
  endAt: Date | null;
  timezone: string;
  venue: string | null;
  isOnline: boolean;
  coverImageUrl: string | null;
  visibility: string;
  status: string;
  capacity: number | null;
  goingCount: number;
  myRsvpStatus: RsvpStatus | null;
}

export interface EventDetail extends EventSummary {
  description: string;
  onlineUrl: string | null;
  host: EventOrganizerView | null;
  cohosts: EventOrganizerView[];
  isOrganizer: boolean;
  waitlistCount: number;
  myWaitlistPosition: number | null;
}

export interface AttendeeView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  status: RsvpStatus;
  waitlistPosition: number | null;
}

export function toOrganizerView(p: Profile | undefined): EventOrganizerView | null {
  if (!p) return null;
  return {
    slug: p.slug,
    firstName: p.firstName,
    lastName: p.lastName,
    avatarUrl: p.avatarUrl,
  };
}

export function toEventSummary(
  e: Event,
  goingCount: number,
  myRsvp: EventRsvp | null,
): EventSummary {
  return {
    slug: e.slug,
    title: e.title,
    startAt: e.startAt,
    endAt: e.endAt,
    timezone: e.timezone,
    venue: e.venue,
    isOnline: e.isOnline,
    coverImageUrl: e.coverImageUrl,
    visibility: e.visibility,
    status: e.status,
    capacity: e.capacity,
    goingCount,
    myRsvpStatus: myRsvp ? myRsvp.status : null,
  };
}

export function toAttendeeView(
  rsvp: EventRsvp,
  p: Profile | undefined,
): AttendeeView {
  return {
    slug: p?.slug ?? '',
    firstName: p?.firstName ?? '',
    lastName: p?.lastName ?? '',
    avatarUrl: p?.avatarUrl ?? null,
    status: rsvp.status,
    waitlistPosition: rsvp.waitlistPosition,
  };
}
