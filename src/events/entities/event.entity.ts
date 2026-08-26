import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ListingAccessibilityAnswerMap } from '../../listings/listing-accessibility';

export enum EventVisibility {
  Public = 'public',
  Members = 'members',
  InviteOnly = 'invite_only',
  // --- gathering audience scope (2026-08-13 design) -------------------------
  // Strict 1st-degree: host + host's accepted connections. See
  // `EventsService.assertCanView` and the browse/search queries.
  Network = 'network',
  // 2nd-degree: the `Network` condition OR a mutual connection between viewer
  // and host. Deliberately excluded from open browse/search (link-only
  // discovery) — see `EventsService.list`/`searchByText`.
  ExtendedNetwork = 'extended_network',
  // Members of the event's own community (`Event.communityId`). Mutually
  // exclusive with the network tiers at the wizard level; the service layer
  // rejects `Community` visibility when no community is set.
  Community = 'community',
}

export enum EventStatus {
  Draft = 'draft',
  Published = 'published',
  Cancelled = 'cancelled',
}

/**
 * Whether the DIRECTORY LISTING a gathering names as its venue has agreed to
 * carry it (LOC-16).
 *
 * Until this existed, any member could point `Event.listingId` at any live
 * business in the directory and that business's public page immediately
 * advertised the gathering. The listing surface already reasons carefully
 * about consent elsewhere (the dispute flow exists precisely because a venue
 * can be tagged queer-friendly without knowing), and an event attachment is
 * the same problem with a bigger blast radius: a bar owner could wake up to a
 * party on their page.
 *
 * TWO STATES ONLY, deliberately. There is no `declined`: an owner who says no
 * DETACHES, which nulls `listingId` outright (see
 * `ListingVenueEventsService.detach`), so every existing reader of the FK
 * stops showing the link without having to remember a third state. A state a
 * reader can forget to check is a leak waiting to happen; a null FK is not.
 *
 * GRANDFATHERED ROWS. `BackfillEventVenueConfirmation1794791000000` set every
 * attachment that already existed to `confirmed` and left `venueConfirmedAt`
 * NULL. So `confirmed` + a null timestamp means "predates this feature, never
 * blanked from the venue page", and `confirmed` + a timestamp means "an owner
 * pressed the button at that instant". Nothing branches on the difference; it
 * is there so the data never claims a consent that was never given.
 */
export enum EventVenueConfirmation {
  Pending = 'pending',
  Confirmed = 'confirmed',
}

@Entity('events')
@Index('IDX_events_status_start_at', ['status', 'startAt'])
// Scoped to `public`/`members` only. The three scoped tiers added for
// gathering audience scope (network/extended_network/community) fall outside
// this partial index by design: `network`/`community` browse hits are served
// via the OR-in `host_id`/`community_id` predicates in `EventsService.list`
// (not this feed-cursor index), and `extended_network` is link-only and never
// reaches the browse feed at all (see the 2026-08-13 design doc, decision 2b).
// Revisit only if a measurement shows a regression — not changed here.
@Index('IDX_events_feed_created_at_id', ['createdAt', 'id'], {
  where: `"status" = 'published' AND "visibility" IN ('public', 'members')`,
})
// LOC-16. Both readers of a venue attachment filter on the listing AND the
// confirmation state together: the public venue page (anonymous variant:
// confirmed only) and the owner's own inbox of what is waiting on their
// listing. Partial on `listing_id IS NOT NULL` because the overwhelming
// majority of gatherings have no listed venue and belong in no index of them.
@Index(
  'IDX_events_listing_venue_confirmation',
  ['listingId', 'venueConfirmation'],
  {
    where: `"listing_id" IS NOT NULL`,
  },
)
export class Event {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  // Nullable since `SetNullContentAuthorFksOnUserErasure1794610000000`: the FK
  // to `users` was `ON DELETE CASCADE`, so erasing one member's account
  // deleted every gathering they ever hosted, future ones included, taking
  // everybody's RSVPs with them. It is now `ON DELETE SET NULL`, so
  // NULL here means "the host's account was erased" rather than "no such row".
  // Read paths must render a removed-member placeholder instead of assuming
  // a non-null id. See `ContentOwnerErasureService` for what happens to the
  // row itself when the account goes.
  @Index('IDX_events_host_id')
  @Column({ type: 'uuid', nullable: true })
  hostId!: string | null;

  @Index('UQ_events_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Column({ type: 'varchar' })
  title!: string;

  @Column({ type: 'text' })
  description!: string;

  @Column({ type: 'timestamptz' })
  startAt!: Date;

  @Column({ type: 'timestamptz', nullable: true })
  endAt!: Date | null;

  @Column({ type: 'varchar' })
  timezone!: string;

  @Column({ type: 'varchar', nullable: true })
  venue!: string | null;

  // Optional link to the directory listing (business) hosting this event, so a
  // listing's detail page can show its upcoming events. Free-text `venue` is
  // kept for events not tied to a listed venue; null here means "not at a
  // listed venue".
  @Index('IDX_events_listing_id')
  @Column({ type: 'uuid', nullable: true })
  listingId!: string | null;

  // ── Does the venue agree to carry this? (LOC-16) ─────────────────────────
  // See `EventVenueConfirmation` for why there are two states and not three,
  // and what a `confirmed` row with a null `venueConfirmedAt` means.
  //
  // Five columns rather than a join table, and that is a decision rather than
  // an accident. An event has AT MOST ONE venue, so an attachment table would
  // be a 1:1 table, not a many-to-many; the fact lives one column away from
  // the FK it qualifies; the CDN-cached venue page read
  // (`DirectoryService.getDirectoryBySlug`) already has this row in hand and
  // would otherwise take a join on the hottest public read in the domain; and
  // every transition changes `listing_id` and its state TOGETHER, which one
  // row makes atomic and two tables would make an invariant somebody has to
  // remember. Postgres stores the nulls in the row's null bitmap, so the four
  // mostly-empty columns cost the overwhelming majority of gatherings (which
  // have no listed venue at all) essentially nothing.
  @Column({
    type: 'enum',
    enum: EventVenueConfirmation,
    enumName: 'events_venue_confirmation_enum',
    default: EventVenueConfirmation.Pending,
  })
  venueConfirmation!: EventVenueConfirmation;

  /** When the listing's owner confirmed, or null. Null on a `confirmed` row
   *  means the attachment predates LOC-16 and was grandfathered by the
   *  backfill migration rather than agreed to by a person. */
  @Column({ type: 'timestamptz', nullable: true })
  venueConfirmedAt!: Date | null;

  /** When the listing's owner was told a gathering had attached to their
   *  venue, so the ask is sent exactly once per attachment. Reset to null
   *  whenever `listingId` changes, because a new venue is a new ask.
   *
   *  Null while the gathering is a draft, or scoped tighter than `members`:
   *  neither can ever reach the venue's public page, so there is nothing for
   *  the owner to consent to yet and telling them would disclose a private
   *  gathering's existence to somebody outside its audience. Publishing or
   *  widening it later raises the ask then. */
  @Column({ type: 'timestamptz', nullable: true })
  venueOwnerNotifiedAt!: Date | null;

  /** The listing whose owner DETACHED this gathering, kept after `listingId`
   *  is nulled. Two jobs: the host's own page can say why their venue link
   *  disappeared, and `EventsService` refuses to re-attach this exact listing,
   *  so "the owner can detach" does not mean "the owner can detach for five
   *  seconds". Holds the most recent detachment; an event has one venue at a
   *  time, so in practice that is the only one there has ever been. */
  @Column({ type: 'uuid', nullable: true })
  venueDetachedListingId!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  venueDetachedAt!: Date | null;

  // Optional link to the community this event belongs to, so a community's
  // page can show its upcoming events. Null means the event isn't tied to a
  // specific community.
  @Index('IDX_events_community_id')
  @Column({ type: 'uuid', nullable: true })
  communityId!: string | null;

  @Column({ type: 'boolean', default: false })
  isOnline!: boolean;

  @Column({ type: 'varchar', nullable: true })
  onlineUrl!: string | null;

  @Column({ type: 'int', nullable: true })
  capacity!: number | null;

  @Column({
    type: 'enum',
    enum: EventVisibility,
    enumName: 'events_visibility_enum',
    default: EventVisibility.Public,
  })
  visibility!: EventVisibility;

  @Column({
    type: 'enum',
    enum: EventStatus,
    enumName: 'events_status_enum',
    default: EventStatus.Draft,
  })
  status!: EventStatus;

  @Column({ type: 'varchar', nullable: true })
  coverImageUrl!: string | null;

  // ── Where it actually is (LOC-04) ────────────────────────────────────────
  // The create-gathering wizard has always asked for a street address,
  // arrival directions, a neighbourhood, a language and a gathering type, and
  // then made the host tick "the accessibility information I have given is
  // accurate" before publishing. None of it had a column, so all of it was
  // discarded on submit. These are those columns.
  //
  // ADDRESS PRIVACY. `address` and `arrivalNotes` are the exact door, and the
  // response mapper withholds both from anyone without a confirmed 'going'
  // RSVP, the same shape `toHousingListingDTO` uses for a home's precise
  // point: a stranger gets the venue name and the neighbourhood, an attendee
  // gets the street and the "ring the bell on the left" note. `venue` and
  // `neighbourhood` stay public because they are what makes a gathering
  // findable at all.
  @Column({ type: 'varchar', length: 300, nullable: true })
  address!: string | null;

  @Column({ type: 'varchar', length: 500, nullable: true })
  arrivalNotes!: string | null;

  // A Lisbon neighbourhood name as the wizard's picker stores it ("Arroios",
  // "Cais do Sodre", "Online", "Other in Lisbon"). Plain text on purpose:
  // Lisbon is the only city this product serves, so there is no city table
  // and no neighbourhood table to key against.
  //
  // Indexed for the `hood=` discovery filter by
  // `CreateEventAnnouncementsAndBans1794701000000`, as a FUNCTIONAL partial
  // index on `lower(neighbourhood)` over published rows — matching the
  // `lower(col) = lower(:value)` predicate `EventsService` builds. There is
  // no `@Index` decorator here because TypeORM cannot express a functional
  // index, and declaring a plain one would describe an index that does not
  // exist.
  @Column({ type: 'varchar', length: 120, nullable: true })
  neighbourhood!: string | null;

  // "PT / EN bilingual", "Portuguese only", "English only", "Other" — the
  // wizard's own canonical values, stored verbatim.
  @Column({ type: 'varchar', length: 80, nullable: true })
  language!: string | null;

  // "Supper club", "Workshop / talk", "Screening", ... — the wizard's type
  // picker, stored verbatim. Indexed for the `type=` discovery filter the
  // same functional-partial way `neighbourhood` above is.
  @Column({ type: 'varchar', length: 80, nullable: true })
  eventType!: string | null;

  // The SAME three-valued answer map business listings use
  // (`listings/listing-accessibility.ts`), deliberately reused rather than
  // forked: "unknown" has to stay a different fact from "no", and a second
  // vocabulary would be a second vocabulary to disagree with the first.
  // Always a complete map on write (the service normalizes), so the wire
  // always carries every question.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  accessibilityAnswers!: ListingAccessibilityAnswerMap;

  // The host's free-text access note, for the honesty six checkboxes cannot
  // carry. Empty string when they wrote none.
  @Column({ type: 'text', default: '' })
  accessibilityNote!: string;

  // ── What it costs (LOC-18) ───────────────────────────────────────────────
  // FREE TEXT, mirroring `Listing.price`'s reasoning exactly: real door
  // pricing here is "5 to 15 EUR sliding scale", "pay what you can at the
  // door", "free, donations to the fund". A numeric column would force every
  // one of those into a lie or an empty cell.
  //
  // DISPLAY ONLY. There is no payment integration on this platform and this
  // column is not the start of one: nothing reads it but the card and the
  // detail page, no endpoint takes money, and no copy anywhere may promise a
  // charge, a refund or a ticket.
  @Column({ type: 'varchar', length: 120, nullable: true })
  cost!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  reminderSentAt!: Date | null;

  // ── Manage-dashboard "Options" toggles — see `AddEventOptionsFlags`'s doc
  // for why only these two of the four mock toggles got a real backend field.
  @Column({ type: 'boolean', default: true })
  allowWaitlist!: boolean;

  @Column({ type: 'boolean', default: true })
  showAttendeeCount!: boolean;

  // ── Recurring series (MSG-10) — see `EventSeries`'s class doc. Both null
  // for a standalone (non-repeating) event; both set together, never one
  // without the other.
  @Index('IDX_events_series_id')
  @Column({ type: 'uuid', nullable: true })
  seriesId!: string | null;

  // 0-based position of this occurrence within its series (0 = the first,
  // the one whose own `startAt` the host originally picked).
  @Column({ type: 'int', nullable: true })
  seriesIndex!: number | null;

  // Millisecond precision (not Postgres's microsecond default): matches the
  // resolution of the JS `Date` cursor `cursorPaginate` builds from this
  // column, so the raw column can be ordered/filtered on directly instead of
  // through a non-indexable `date_trunc(...)` wrapper — see
  // `1785001400000-NarrowCursorCreatedAtPrecision.ts` and
  // `common/cursor-pagination.ts`.
  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
