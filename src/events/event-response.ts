import { toImageUrl } from '../common/image-url';
import { Paginated } from '../common/pagination';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import { Profile } from '../users/entities/profile.entity';
import { Event } from './entities/event.entity';
import { EventLineupEntry } from './entities/event-lineup-entry.entity';
import { EventRsvp, RsvpStatus } from './entities/event-rsvp.entity';
import { EventSeries } from './entities/event-series.entity';

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
  /** Crop rect for `coverImageUrl`, when the host reframed it. */
  coverCrop?: CropRect;
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
  // The directory listing this event's venue is linked to, or null for a
  // free-text venue — same plain-column-on-every-row precedent as
  // `communityId` above. Resolving it to a display name/slug (`venueListing`
  // below) DOES need a lookup, so that stays detail-only, mirroring
  // `communitySlug`'s split from `communityId` exactly.
  listingId: string | null;
  /** The event's host, batch-resolved from `hostId` (one `profilesByUserIds`
   *  lookup per page — see `EventsService.summarize`), or `null` when the
   *  host's profile can't be resolved (deleted account). Rides on every
   *  summary/card, not just the detail view: `MyEvents`'s "Block host" flow
   *  needs the host's own member slug (not just an org label), which the
   *  list-level `GET /events` response previously carried nowhere. */
  host: EventOrganizerView | null;
  // The recurring series this event belongs to, or `null` for a standalone
  // event. Rides on every summary/card (not just the detail view) so the My
  // Events "this repeats weekly" line (`SeriesLine`, FE) and the manage
  // dashboard's this-vs-future edit/cancel choice both have what they need
  // without a second request — see `EventSeries`'s class doc.
  series: EventSeriesView | null;
}

// One event's own position + cadence within its `EventSeries` — see
// `EventSeries`'s class doc. `occurrenceCount` is the series' TOTAL
// generated occurrences (not "remaining"); `index` is this event's own
// 0-based position within them.
export interface EventSeriesView {
  id: string;
  cadence: string;
  index: number;
  occurrenceCount: number;
}

export function toEventSeriesView(
  event: Event,
  series: EventSeries | undefined,
): EventSeriesView | null {
  if (!event.seriesId || event.seriesIndex === null || !series) return null;
  return {
    id: event.seriesId,
    cadence: series.cadence,
    index: event.seriesIndex,
    occurrenceCount: series.occurrenceCount,
  };
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
  // The linked venue's display name + public slug (or null when `listingId`
  // is null, or the listing is no longer live) — resolved via
  // `ListingLookupService.findLive` in `EventsService.buildDetail`, same
  // detail-only lookup shape as `communitySlug` immediately above. The
  // frontend builds the `/local/directory/:slug` link itself (see
  // `businessPath` in `routeMap.ts`) rather than the backend emitting a path.
  venueListing: { slug: string; name: string } | null;
  host: EventOrganizerView | null;
  cohosts: EventOrganizerView[];
  isOrganizer: boolean;
  waitlistCount: number;
  myWaitlistPosition: number | null;
  /** Manage-dashboard "Show attendee count" toggle (`Event.showAttendeeCount`).
   *  Detail-only (not on `EventSummary`/browse cards — see
   *  `AddEventOptionsFlags`'s doc for the scoping call): the FE's
   *  `detailToGathering` hides the numeric "spots" copy from a non-organizer
   *  viewer when this is `false`. */
  showAttendeeCount: boolean;
  /** Manage-dashboard "Allow waitlist" toggle (`Event.allowWaitlist`) — when
   *  `false`, `RsvpService.rsvp()` rejects a 'going' RSVP at capacity instead
   *  of waitlisting. Detail-only, read by `SettingsTab` to seed the toggle. */
  allowWaitlist: boolean;
  /** The viewer's own RSVP details ("Anything we should know?" — guest count,
   *  access/dietary needs, visibility), or `null` when they have no active
   *  RSVP. Rides free on this same detail fetch so `RsvpDetailsModal` (FE)
   *  can load-on-open without a second request. */
  myRsvpDetails: RsvpDetailsView | null;
  /**
   * MSG-12 — a small pre-RSVP "who else is going" preview (safety-in-numbers:
   * seeing familiar/other attendees before committing to show up matters on a
   * queer-community platform). At most `EventsService.ATTENDEE_PREVIEW_LIMIT`
   * profiles, earliest RSVP first. Privacy-filtered for a non-organizer
   * viewer: empty when the host has turned off `showAttendeeCount`
   * (`EventsService.buildGoingAttendeesPreview`); always block-filtered
   * (blocked/blocking members never appear, in either direction — same rule
   * as `EventsService.attendees`). The organizer's own view is never gated by
   * `showAttendeeCount` — that toggle only hides the signal from others. */
  goingAttendeesPreview: EventOrganizerView[];
  /** The block-filtered/privacy-gated total behind `goingAttendeesPreview` —
   *  NOT the same as `EventSummary.goingCount` (which is the raw, unfiltered
   *  RSVP count used for the public "N going" spots copy). The FE derives its
   *  own "+N more" from `goingAttendeesPreviewTotal - goingAttendeesPreview.length`. */
  goingAttendeesPreviewTotal: number;
}

/** The four self-service fields `RsvpDetailsModal` (FE) reads/writes — see
 *  `EventRsvp`'s "RSVP details" columns and `RsvpService.updateRsvpDetails`. */
export interface RsvpDetailsView {
  guestCount: number;
  accessNeeds: string | null;
  dietaryNeeds: string | null;
  visibility: string | null;
}

export function toRsvpDetailsView(rsvp: EventRsvp): RsvpDetailsView {
  return {
    guestCount: rsvp.guestCount,
    accessNeeds: rsvp.accessNeeds,
    dietaryNeeds: rsvp.dietaryNeeds,
    visibility: rsvp.visibility,
  };
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
  // Pre-loaded crop lookup for `coverImageUrl` — the caller batches ONE
  // `MediaCropService.getMany` and passes the resulting Map straight through;
  // this mapper stays synchronous.
  crops: Map<string, CropRect> = new Map(),
  // Pre-resolved host profile — the caller batches ONE `profilesByUserIds`
  // lookup per page (mirrors `crops` above), keyed by `e.hostId`.
  host: EventOrganizerView | null = null,
  // Pre-loaded series row for `e.seriesId`, when set — the caller batches
  // ONE lookup per page (mirrors `crops`/`host` above), keyed by series id.
  series: EventSeries | undefined = undefined,
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
    coverCrop: cropFor(e.coverImageUrl, crops),
    visibility: e.visibility,
    status: e.status,
    capacity: e.capacity,
    goingCount,
    isFull: e.capacity !== null && goingCount >= e.capacity,
    myRsvpStatus: myRsvp ? myRsvp.status : null,
    isBookmarked,
    communityId: e.communityId,
    listingId: e.listingId,
    host,
    series: toEventSeriesView(e, series),
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
