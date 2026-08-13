import { toImageUrl } from '../common/image-url';
import { Paginated } from '../common/pagination';
import { Profile } from '../users/entities/profile.entity';
import { Event } from './entities/event.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
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
  // Whether the event is at capacity — `capacity !== null && goingCount >=
  // capacity`. Unlimited-capacity events (`capacity === null`) are never full.
  // Derived here so the FE's RSVP control can flip to "Join the waitlist"
  // without recomputing the rule client-side.
  isFull: boolean;
  myRsvpStatus: RsvpStatus | null;
  // Whether the viewer has bookmarked ("saved") this event. Computed in batch
  // (one IN-query per page — see `EventsService.summarize`), never per-row.
  isBookmarked: boolean;
  // The event's own community, or null if it isn't filed to one. Plain column
  // on `Event` already loaded by every query that touches an event row — no
  // extra join, so it's cheap enough to carry on every summary/card, not just
  // the detail view (unlike `communitySlug` below, which DOES need a join and
  // is detail-only — see `EventDetail`).
  communityId: string | null;
}

export interface EventDetail extends EventSummary {
  description: string;
  onlineUrl: string | null;
  // The event's own community slug (or null) — resolved from `communityId`
  // via one extra lookup in `EventsService.buildDetail` (a single-event
  // fetch, not a hot list query), so the edit UI can offer the `community`
  // audience-scope tier for an event that already has a community without a
  // second round trip. Deliberately NOT added to `EventSummary`/browse-list
  // rows: doing so would require a join (or an extra batched lookup) on every
  // row of a hot browse/search page for a field only the edit flow needs.
  communitySlug: string | null;
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

// `GET/PUT /events/:slug/lineup` — the "who performed" credit list (Personas
// Phase 5, Moment 5). `name` mirrors `EndorserView`'s shape (a single
// display string, not `firstName`/`lastName`), since the lineup is a public
// credit list, not an organizer-management view.
export interface EventLineupEntryView {
  slug: string;
  name: string;
  avatarUrl: string | null;
  role: string;
}

// `viewerEntry` is the caller's own row (or null) — lets the FE cheaply ask
// "am I on the bill, and what role" without scanning `entries`.
export interface EventLineupDTO {
  entries: EventLineupEntryView[];
  viewerEntry: EventLineupEntryView | null;
}

export function toLineupEntryView(
  entry: EventLineupEntry,
  profile: Profile | undefined,
): EventLineupEntryView | null {
  if (!profile) return null;
  return {
    slug: profile.slug,
    name: `${profile.firstName} ${profile.lastName}`.trim(),
    avatarUrl: toImageUrl(profile.avatarUrl),
    role: entry.role,
  };
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
  isBookmarked: boolean,
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
    isFull: e.capacity !== null && goingCount >= e.capacity,
    myRsvpStatus: myRsvp ? myRsvp.status : null,
    isBookmarked,
    communityId: e.communityId,
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
