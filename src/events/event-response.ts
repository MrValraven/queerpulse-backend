import { toImageUrl } from '../common/image-url';
import { Paginated } from '../common/pagination';
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

/**
 * `GET /events/:slug/attendees?status=&page=` — one RSVP status's own
 * paginated page (`going` or `waitlisted`, never both at once — see
 * `EventsService.attendees`). `capacity` rides along so the FE doesn't need a
 * second request just to render the "N of capacity spots filled" bar; `total`
 * IS that status's count (going-count or waitlist-count, depending on which
 * `status` was requested).
 */
export interface AttendeesPageDTO extends Paginated<AttendeeView> {
  capacity: number | null;
}

export function toOrganizerView(
  profile: Profile | undefined,
): EventOrganizerView | null {
  if (!profile) return null;
  return {
    slug: profile.slug,
    firstName: profile.firstName,
    lastName: profile.lastName,
    avatarUrl: toImageUrl(profile.avatarUrl),
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
    coverImageUrl: toImageUrl(e.coverImageUrl),
    visibility: e.visibility,
    status: e.status,
    capacity: e.capacity,
    goingCount,
    myRsvpStatus: myRsvp ? myRsvp.status : null,
  };
}

export function toAttendeeView(
  rsvp: EventRsvp,
  profile: Profile | undefined,
): AttendeeView {
  return {
    slug: profile?.slug ?? '',
    firstName: profile?.firstName ?? '',
    lastName: profile?.lastName ?? '',
    avatarUrl: toImageUrl(profile?.avatarUrl),
    status: rsvp.status,
    waitlistPosition: rsvp.waitlistPosition,
  };
}
