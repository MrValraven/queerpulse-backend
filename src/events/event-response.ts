import { toImageUrl } from '../common/image-url';
import { Paginated } from '../common/pagination';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import type { ListingAccessibilityAnswerMap } from '../listings/listing-accessibility';
import { Profile } from '../users/entities/profile.entity';
import { EventAnnouncement } from './entities/event-announcement.entity';
import { EventBan } from './entities/event-ban.entity';
import { Event, EventVenueConfirmation } from './entities/event.entity';
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
  // How many MEMBERS hold a 'going' RSVP. This is a headcount of people who
  // pressed the button, and it is what the "N going" line has always meant.
  // It is NOT the seat count: see `seatsTaken`.
  goingCount: number;
  // How many SEATS those RSVPs actually occupy: one per going member, plus
  // every extra guest they declared (`event_rsvps.guest_count`). This is the
  // number capacity is measured against, and the number "spots left" must be
  // derived from (`capacity - seatsTaken`).
  //
  // Until LOC-07 there was no such number: capacity compared itself against
  // the row count, so a 20-seat gathering where ten members each brought a
  // plus-one reported ten free seats while thirty people arrived.
  seatsTaken: number;
  // Whether the event is at capacity — `capacity !== null && seatsTaken >=
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
  // ── Where and what kind (LOC-04) ─────────────────────────────────────────
  // The neighbourhood rides on the CARD, not just the detail: it is the
  // filter a member browses by ("what is on near Arroios") and the one piece
  // of location a non-attendee is always allowed. The exact `address` is
  // detail-only AND attendee-only — see `EventDetail.address`.
  neighbourhood: string | null;
  /** The wizard's gathering type ("Supper club", "Workshop / talk", ...), or
   *  null for an event created before the field existed. */
  eventType: string | null;
  /** The host's free-text door price (LOC-18) — "5 to 15 EUR sliding scale",
   *  "pay what you can at the door". DISPLAY ONLY: this platform takes no
   *  payment, so no reader of this field may promise a charge or a ticket.
   *  Null when the host said nothing about cost. */
  cost: string | null;
  /** Whether `cost` reads as free (or was left unset, the historical
   *  default). Derived server-side by the SAME rule the `cost=free` browse
   *  filter uses, so a "free" chip on a card can never disagree with the
   *  filter that produced the card. */
  isFree: boolean;
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
  /**
   * ORGANISERS ONLY (LOC-16): whether the venue this gathering names has
   * agreed to carry it, so the host can see why their venue is or is not
   * showing on the business's own page.
   *
   * `undefined` for every other reader, the same shape `AttendeeView`'s
   * organiser-only fields use. A member browsing a gathering has no stake in
   * a consent negotiation between its host and a business, and publishing
   * "this venue has not agreed to this" to strangers would turn a private
   * pending state into a public accusation.
   *
   * `undefined` for an organiser too when the gathering has never named a
   * listed venue: there is no attachment to describe. A free-text venue needs
   * nobody's consent and is unaffected by any of this.
   *
   * Three states:
   *  - `pending`: attached, the owner has not answered. Shows to signed-in
   *    members on the venue page, flagged as unconfirmed; withheld from the
   *    anonymous, CDN-cached version of that page.
   *  - `confirmed`: the owner agreed (or the attachment predates LOC-16 and
   *    was grandfathered, in which case `confirmedAt` is null).
   *  - `detached`: the owner removed it. `venueListing` is null and the
   *    gathering has fallen back to its free-text `venue` string. The host
   *    cannot re-attach that same venue.
   */
  venueAttachment?: EventVenueAttachmentView;
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

  // ── Where it actually is (LOC-04) ────────────────────────────────────────
  /**
   * The street address, or null when the viewer has not earned it.
   *
   * ADDRESS PRIVACY, the same rule `toHousingListingDTO` applies to a home's
   * precise point: `venue` and `neighbourhood` are public (they are what
   * makes a gathering findable), and the exact door is disclosed only to an
   * organiser or to somebody holding a confirmed 'going' RSVP. A house party
   * or a pop-up can therefore be listed at all, which it could not be while
   * the only location field was a 300-character venue name.
   *
   * `locationPrecision` tells the client which of the two it is holding, so
   * the page can honestly say "the address is shared once you RSVP" rather
   * than rendering an empty line.
   */
  address: string | null;
  /** The host's arrival directions ("through the courtyard, second door,
   *  ring twice"), gated exactly like `address`. */
  arrivalNotes: string | null;
  locationPrecision: 'venue' | 'exact';
  /** "PT / EN bilingual", "Portuguese only", ... or null. */
  language: string | null;
  /** The gathering's six accessibility answers, always a complete map. The
   *  same three-valued vocabulary business listings use, so "unknown" stays
   *  distinct from "no". */
  accessibilityAnswers: ListingAccessibilityAnswerMap;
  /** The host's free-text access note, or '' when they wrote none. */
  accessibilityNote: string;
  /** Announcements the organisers have sent, newest first (LOC-06). Rides on
   *  the detail so an attendee reads "we moved to the back room" on the page
   *  they are already looking at, not only in a notification that has since
   *  scrolled away. Empty for a viewer with no stake in the event. */
  announcements: EventAnnouncementView[];
}

/**
 * The state of a gathering's link to a directory listing, as its ORGANISERS
 * see it (LOC-16). See `EventDetail.venueAttachment`.
 */
export interface EventVenueAttachmentView {
  state: 'pending' | 'confirmed' | 'detached';
  /** ISO 8601, or null when the state is not `confirmed`, or when it is
   *  `confirmed` because the attachment predates venue consent and was
   *  grandfathered rather than agreed to. */
  confirmedAt: string | null;
  /** ISO 8601 when the owner detached, null otherwise. */
  detachedAt: string | null;
}

/**
 * Builds the organiser-only venue-attachment view, or `undefined` when this
 * gathering has never named a listed venue and there is nothing to describe.
 *
 * `detached` is derived rather than stored: a detachment nulls `listing_id`
 * outright (so no reader can forget to check a third enum state and leak the
 * link) and leaves `venueDetachedAt` behind as the record that it happened.
 */
export function toEventVenueAttachmentView(
  event: Event,
): EventVenueAttachmentView | undefined {
  if (!event.listingId) {
    if (!event.venueDetachedAt) return undefined;
    return {
      state: 'detached',
      confirmedAt: null,
      detachedAt: event.venueDetachedAt.toISOString(),
    };
  }
  return {
    state:
      event.venueConfirmation === EventVenueConfirmation.Confirmed
        ? 'confirmed'
        : 'pending',
    confirmedAt: event.venueConfirmedAt
      ? event.venueConfirmedAt.toISOString()
      : null,
    detachedAt: null,
  };
}

/** One host announcement as served to attendees and organisers alike
 *  (`EventDetail.announcements`, `GET /events/:slug/announcements`). */
export interface EventAnnouncementView {
  id: string;
  body: string;
  createdAt: Date;
  /** The organiser who sent it, or null when their account has since been
   *  erased. */
  author: EventOrganizerView | null;
  /** How many members the fan-out reached at send time. Organiser-facing
   *  detail; an attendee simply ignores it. */
  recipientCount: number;
}

export function toEventAnnouncementView(
  announcement: EventAnnouncement,
  author: Profile | undefined,
): EventAnnouncementView {
  return {
    id: announcement.id,
    body: announcement.body,
    createdAt: announcement.createdAt,
    author: toOrganizerView(author),
    recipientCount: announcement.recipientCount,
  };
}

/** One barred member (`GET /events/:slug/bans`) — ORGANISERS ONLY. The
 *  `reason` is the organiser's own note and never leaves this view. */
export interface EventBanView {
  slug: string;
  firstName: string;
  lastName: string;
  avatarUrl: string | null;
  reason: string | null;
  createdAt: Date;
}

export function toEventBanView(
  ban: EventBan,
  profile: Profile | undefined,
): EventBanView {
  return {
    slug: profile?.slug ?? '',
    firstName: profile?.firstName ?? '',
    lastName: profile?.lastName ?? '',
    avatarUrl: toImageUrl(profile?.avatarUrl),
    reason: ban.reason,
    createdAt: ban.createdAt,
  };
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
  /**
   * When a host or co-host marked this attendee as arrived, or null (LOC-03).
   * ORGANISERS ONLY: a regular viewer of a guest list has no business
   * knowing who has physically walked through a door and who has not.
   */
  checkedInAt: Date | null;
  /**
   * ── ATTENDEE PII, ORGANISERS ONLY (LOC-07) ────────────────────────────────
   *
   * The three things an attendee typed into "Anything we should know?": how
   * many people they are bringing, what they need to get in, what they can
   * eat. A member declaring "I use a wheelchair, I need step-free entry" and
   * choosing "everyone can see this" used to reach nobody at all: the stored
   * `visibility` column was written by the modal and read by no code path,
   * and the organiser's list carried name, avatar and status and nothing
   * else.
   *
   * Two gates, both of which must pass:
   *  1. The viewer is the host or a co-host. These fields are `undefined` for
   *     every other reader, on every route, and the attendee list is never
   *     `@Public()`.
   *  2. The attendee's OWN `visibility` choice permits it. `justMe` withholds
   *     the free-text needs from the organiser too (the guest count still
   *     shows, because it is how many seats the host must lay); `everyone`
   *     and `connections` disclose them to the organiser, who is the person
   *     the answers were written for.
   *
   * A row that has answered nothing simply carries a zero guest count and
   * nulls, which is a different fact from "withheld" only in that there was
   * nothing to withhold.
   */
  guestCount?: number;
  accessNeeds?: string | null;
  dietaryNeeds?: string | null;
  /** The attendee's own "who can see this" choice, echoed so the organiser's
   *  UI can say why a needs line is absent rather than implying nobody has
   *  any. Organisers only, like the three fields above. */
  detailsVisibility?: string | null;
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
  /** Members holding a 'going' RSVP, whichever status page was requested. */
  goingCount: number;
  /** Seats those RSVPs occupy: going members plus their declared guests. The
   *  number to compare against `capacity` (LOC-07). */
  seatsTaken: number;
  /** Members on the waitlist, whichever status page was requested. */
  waitlistCount: number;
  /**
   * How many 'going' members have been checked in at the door (LOC-03).
   *
   * `null` means NO LONGER RECORDED, never zero. The attendance retention
   * sweep erases `checked_in_at` once a gathering is past its window
   * (`EventAttendanceRetentionService`), at which point the count cannot be
   * stated at all and a client must render "no longer recorded" rather than a
   * figure. `0` keeps its literal meaning: nobody arrived.
   *
   * Always `0` for a non-organiser viewer, who never sees check-in state and
   * for whom "no longer recorded" would be the wrong explanation.
   */
  checkedInCount: number | null;
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
  // Seats occupied: `goingCount` plus every declared extra guest. Defaults to
  // the row count so a caller with no guest tally in hand (or a fixture)
  // behaves exactly as this function did before LOC-07, rather than silently
  // reporting zero seats taken.
  seatsTaken: number = goingCount,
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
    seatsTaken,
    isFull: e.capacity !== null && seatsTaken >= e.capacity,
    myRsvpStatus: myRsvp ? myRsvp.status : null,
    isBookmarked,
    communityId: e.communityId,
    listingId: e.listingId,
    neighbourhood: e.neighbourhood,
    eventType: e.eventType,
    cost: e.cost,
    isFree: isFreeCost(e.cost),
    host,
    series: toEventSeriesView(e, series),
  };
}

/**
 * @param forOrganizer When true the viewer is the host or a co-host, so the
 *   check-in stamp and the attendee's declared needs may be attached. Defaults
 *   to FALSE — every other read of a guest list gets name, avatar and status
 *   and nothing more, which is what this route carried before LOC-07.
 */
export function toAttendeeView(
  rsvp: EventRsvp,
  profile: Profile | undefined,
  forOrganizer = false,
): AttendeeView {
  const base: AttendeeView = {
    slug: profile?.slug ?? '',
    firstName: profile?.firstName ?? '',
    lastName: profile?.lastName ?? '',
    avatarUrl: toImageUrl(profile?.avatarUrl),
    status: rsvp.status,
    waitlistPosition: rsvp.waitlistPosition,
    checkedInAt: forOrganizer ? rsvp.checkedInAt : null,
  };
  if (!forOrganizer) return base;
  // The attendee's own visibility choice, honoured at last. `justMe` keeps
  // the free-text needs private even from the organiser; the guest count is
  // not covered by it, because it is a seat-planning fact the host has to
  // have to run the room at all.
  const disclosesNeeds = rsvp.visibility !== 'justMe';
  return {
    ...base,
    guestCount: rsvp.guestCount,
    accessNeeds: disclosesNeeds ? rsvp.accessNeeds : null,
    dietaryNeeds: disclosesNeeds ? rsvp.dietaryNeeds : null,
    detailsVisibility: rsvp.visibility,
  };
}

/**
 * Whether a free-text cost reads as free.
 *
 * The ONE place this rule lives: the `cost=free` browse filter's SQL mirrors
 * it, and `EventSummary.isFree` is produced by it, so a card's "free" chip
 * can never disagree with the filter that produced the card.
 *
 * An unset cost counts as free, because that is what every gathering created
 * before the column existed actually was: the wizard had no pricing step, so
 * nobody was charged at a door this platform knew about.
 */
export function isFreeCost(cost: string | null): boolean {
  if (cost === null) return true;
  const normalized = cost.trim().toLowerCase();
  if (normalized === '') return true;
  // Portuguese and English, both the way a host actually writes it.
  return (
    normalized === 'free' ||
    normalized === 'gratis' ||
    normalized === 'gratuito' ||
    normalized === 'grátis' ||
    normalized === 'free entry' ||
    normalized === 'entrada livre' ||
    normalized === 'entrada gratuita' ||
    normalized === '0' ||
    normalized === '0 eur' ||
    normalized === '0eur' ||
    normalized === 'no cost'
  );
}
