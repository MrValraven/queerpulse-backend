import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';
import type { ListingAccessibilityAnswerMap } from '../listing-accessibility';
import type { ListingGalleryPhoto } from '../listing-photo-gallery';

/**
 * Moderation lifecycle for a member-submitted business directory listing.
 * Mirrors the frontend's `ListingStatus` union
 * (`queerpulse/src/features/marketing/listBusiness/listBusiness.data.ts`).
 * Members never self-transition their own listing (see
 * `ListingsController.setStatus`'s `RolesGuard` gate) — only a
 * moderator/admin moves it out of `Review`.
 */
export enum ListingStatus {
  Review = 'review',
  Question = 'question',
  Live = 'live',
}

/**
 * Whether the BUSINESS is still trading, as reported by the business itself.
 *
 * Deliberately separate from `status`, which is the MODERATION lifecycle
 * (`review`/`question`/`live`) and is owned by the moderator queue. A venue
 * that shut in March is still a perfectly well-moderated `live` listing; what
 * changed is the venue, not our review of it. Overloading `status` with
 * closure would have meant a moderator action every time a business took a
 * summer break, and would have destroyed the record of the moderation decision
 * itself.
 *
 * Set ONLY by the listing owner (`PATCH /listings/:ref/operating-state`).
 * Setting it never moves `status` and never sends the listing back for
 * re-review.
 *
 * `permanently_closed` is the one value that withdraws the listing from every
 * public browse/search/map/safe-space result (`DirectoryService`). The detail
 * page still resolves so existing links, reviews and the closure notice all
 * survive. `temporarily_closed` and `moved` keep appearing in results, badged.
 */
export enum ListingOperatingState {
  Open = 'open',
  TemporarilyClosed = 'temporarily_closed',
  PermanentlyClosed = 'permanently_closed',
  Moved = 'moved',
}

/** Safe-space badge lifecycle on a business listing. `none` = not a safe space. */
export enum SafeSpaceStatus {
  None = 'none',
  Verified = 'verified',
  Removed = 'removed',
}

/** One "what you can rely on" promise shown on the safe-space detail page. */
export interface SafeSpacePromise {
  title: string;
  desc: string;
}

/** A member vouch for a safe space. `initials`/`tint` are derived server-side. */
export interface SafeSpaceVouch {
  name: string;
  byline: string;
  text: string;
  when: string;
}

/** Removal narrative, populated only when `safeSpaceStatus = removed`. */
export interface SafeSpaceRemoval {
  reason: string;
  removedDate: string;
  listedSince: string;
  flags: number;
  reasonLong: string[];
  timeline: { date: string; event: string }[];
  whatNow: string;
}

/** A single "what it actually is" bullet — mirrors the frontend's `WitLine`. */
export interface ListingWitLine {
  id: string;
  text: string;
}

/** One opening interval within a weekday — `from`/`to` are `HH:MM` 24h
 * strings. When `to <= from` the interval is OVERNIGHT (it closes the next
 * day, e.g. `22:00`→`02:00`); the frontend renders that from the arithmetic
 * alone, with no special marker. Mirrors the frontend's `HoursInterval`. */
export interface ListingHoursInterval {
  from: string;
  to: string;
}

/** One weekday's opening hours — mirrors the frontend's `DayHours`, keyed by
 * the frontend's `DAYS` id (e.g. `Mon`, `Tue`, ...) in the `hours` column.
 * A day can hold 1..2 intervals when `open` (e.g. a lunch + dinner split);
 * `intervals` is `[]` when the day is closed. Superseded the old flat
 * `{ open, from, to }` shape (rewritten in place by
 * `1785801000000-RewriteListingHoursToIntervals`). */
export interface ListingDayHours {
  open: boolean;
  intervals: ListingHoursInterval[];
}

/**
 * One calendar date whose hours differ from the weekly `hours` grid: a public
 * holiday, an early close, a one-off private event.
 *
 * Extends `ListingDayHours` on purpose rather than inventing an inverted
 * `closed` flag, so a single date reads with EXACTLY the same `open` +
 * `intervals` semantics as the seven weekday entries it overrides. `open:
 * false` with `intervals: []` is the "shut that day" case; `open: true` with
 * 1..2 non-overlapping intervals is a changed (often shortened) day. The same
 * `@IsValidDayHours()` rule validates both shapes.
 *
 * `date` is a `YYYY-MM-DD` calendar date in the listing's own `timezone`
 * rather than an instant. `note` is a short owner explanation ("Christmas Eve, closing
 * early") and may be empty.
 *
 * The frontend does the "open now" arithmetic: an exception whose `date`
 * matches today wins over the weekday entry outright.
 */
export interface ListingHoursException extends ListingDayHours {
  date: string;
  note: string;
}

/**
 * One priced thing a business actually sells: a haircut, a 50-minute session,
 * a half-sleeve, a first consultation.
 *
 * `price` is deliberately FREE TEXT rather than a number or a range. Real
 * pricing in this directory is "from 25 EUR", "sliding scale, 30-60 EUR",
 * "first session free", "by quote"; a numeric column would have forced every
 * one of those into a lie or an empty cell. The at-a-glance `price` band on
 * the listing (free to three euro signs) is unchanged and stays the signal a
 * card shows; this list is the detail behind it.
 *
 * `note` is a short qualifier ("60 min", "students and unwaged"), and may be
 * empty.
 */
export interface ListingServiceOffering {
  name: string;
  price: string;
  note: string;
}

/** Mirrors the frontend's `ListingDraft["social"]`. */
export interface ListingSocial {
  instagram: string;
  website: string;
  email: string;
  phone: string;
}

/**
 * LEGACY. Mirrors the frontend's old `Record<PhotoKey, string>` (`photos`/`alt`
 * columns) — fixed to four named `PhotoKey` slots.
 *
 * Superseded by the ordered `photoGallery` column (`ListingGalleryPhoto`). It
 * survives as the shape of the two compatibility columns and of the legacy
 * response fields derived from the gallery; see `legacySlotsFromGallery`.
 */
export interface ListingPhotoSet {
  wide: string;
  d1: string;
  d2: string;
  vibe: string;
}

/**
 * A member-submitted business directory listing (spec §3 Tier 4
 * "listings"). The full wizard draft
 * (`queerpulse/.../listBusiness.data.ts#ListingDraft`) is persisted flat —
 * one column per draft field — plus the server-assigned identity/moderation
 * fields (`ref`, `slug`, `status`, `ownerId`) the review flow renders.
 *
 * `ref` (e.g. `QPL-2026-0007`) is the human-readable business reference the
 * frontend addresses in every mutation path (`GET/PATCH/DELETE /listings/:ref`
 * — see `listings.api.ts`); `slug` is a separate, purely cosmetic
 * `slugify(name)`-derived value carried through on the DTO but never used as
 * a lookup key by the frontend.
 */
@Entity('listings')
export class Listing {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index('UQ_listings_ref', { unique: true })
  @Column({ type: 'varchar' })
  ref!: string;

  @Index('UQ_listings_slug', { unique: true })
  @Column({ type: 'varchar' })
  slug!: string;

  @Index('IDX_listings_owner_id')
  @Column({ type: 'uuid' })
  ownerId!: string;

  // Filtered on nearly every directory read (`DirectoryService`'s
  // `status = live` gates) and the admin moderation queue
  // (`ListingsService.listQueue`) — mirrors `HousingListing.status`
  // (`housing-listings/entities/housing-listing.entity.ts`), the sibling
  // entity that already indexes the same access pattern.
  @Index('IDX_listings_status')
  @Column({
    type: 'enum',
    enum: ListingStatus,
    enumName: 'listings_status_enum',
    default: ListingStatus.Review,
  })
  status!: ListingStatus;

  // --- ListingDraft fields (flat, one column each) ---

  @Column({ type: 'varchar', default: '' })
  path!: string;

  /**
   * RETIRED: how a submitter said they would prove they run the place (email /
   * instagram / post / later). No longer collected by `CreateListingDto` and no
   * longer served by any response builder, and nothing in the backend ever read
   * it. The column stays mapped so the values already stored on existing rows
   * are not destroyed. Do not add new writers.
   */
  @Column({ type: 'varchar', default: '' })
  verify!: string;

  @Column({ type: 'varchar' })
  name!: string;

  @Column({ type: 'text', array: true, default: '{}' })
  cats!: string[];

  @Column({ type: 'varchar', default: '' })
  hood!: string;

  /** City the venue sits in. Drives the detail page's location eyebrow and the
   * JSON-LD `addressRegion`; empty ⇒ the frontend defaults to Lisbon (where the
   * directory currently lives). Not part of the member wizard yet — populated by
   * seed/ops for non-Lisbon listings. */
  @Column({ type: 'varchar', default: '' })
  city!: string;

  /** IANA timezone the venue's `hours` are expressed in (e.g. `Europe/Lisbon`),
   * so the frontend's "Open now" is correct regardless of the visitor's own
   * timezone. Empty ⇒ the frontend defaults to Europe/Lisbon. */
  @Column({ type: 'varchar', default: '' })
  timezone!: string;

  @Column({ type: 'varchar', default: '' })
  badge!: string;

  @Column({ type: 'text', default: '' })
  evidence!: string;

  @Column({ type: 'varchar', default: '' })
  price!: string;

  @Column({ type: 'varchar', length: 140, default: '' })
  blurb!: string;

  @Column({ type: 'varchar', default: '' })
  tagline!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  whatItIs!: ListingWitLine[];

  @Column({ type: 'text', array: true, default: '{}' })
  tags!: string[];

  /**
   * ATMOSPHERE and service tags only ("Walk-ins welcome", "Solo-friendly",
   * "Dog-friendly", "Budget-friendly"), rendered as positive checks.
   *
   * Accessibility used to live here too and no longer does. A flat tag list
   * can only ever say yes: a missing "Wheelchair accessible" tag meant either
   * "no" or "nobody asked", and the reader could not tell which. Accessibility
   * moved to `accessibilityAnswers` below, which can say no. The migration
   * that added it also stripped the accessibility-flavoured tags out of this
   * column (see `LEGACY_GOOD_FOR_ACCESSIBILITY_TAGS`) so they stopped
   * rendering twice. Do not put an access claim back in here.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  goodFor!: string[];

  /**
   * The venue's answers to the canonical accessibility questions
   * (`LISTING_ACCESSIBILITY_QUESTION_SLUGS`), one answer per slug.
   *
   * Always a COMPLETE map: the write-side normalizer fills every question, so
   * an unanswered question is stored as a real `unknown` rather than as an
   * absent key. That distinction is the whole point. "We do not have a
   * step-free entrance" and "nobody has ever asked us" are different facts,
   * and a member planning their evening around a wheelchair needs to be able
   * to tell them apart.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  accessibilityAnswers!: ListingAccessibilityAnswerMap;

  /**
   * The owner's free-text accessibility note, for the honesty the six
   * structured answers cannot carry: "two steps at the door, staff will bring
   * the ramp out if you ring the bell". Empty when they wrote none.
   */
  @Column({ type: 'text', default: '' })
  accessibilityNote!: string;

  /**
   * What the business sells and what it costs, as an ordered list. Empty for
   * the many listings that have nothing to price (a bar, a gallery). For a
   * barber, a therapist, a tattoo studio or a clinic, this is the last
   * question before booking, and the single `price` band above cannot answer
   * it. `price` stays: it is the at-a-glance signal, and this is the detail.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  services!: ListingServiceOffering[];

  @Column({ type: 'text', array: true, default: '{}' })
  langs!: string[];

  /** Online-only business (no physical location). When true the listing has no
   *  address or coordinates and never appears as a map pin. */
  @Column({ type: 'boolean', default: false })
  online!: boolean;

  @Column({ type: 'text', default: '' })
  address!: string;

  @Column({ type: 'boolean', default: false })
  geocoded!: boolean;

  @Column({ type: 'double precision', nullable: true })
  latitude!: number | null;

  @Column({ type: 'double precision', nullable: true })
  longitude!: number | null;

  @Column({ type: 'jsonb', default: () => "'{}'" })
  hours!: Record<string, ListingDayHours>;

  @Column({ type: 'text', default: '' })
  hoursNote!: string;

  /** Per-date overrides of the weekly `hours` grid (holidays, early closes).
   * Empty array when the venue keeps the same hours all year. Capped at
   * `MAX_HOURS_EXCEPTIONS` by `ListingHoursExceptionDto`'s `@ArrayMaxSize`,
   * and every `date` in it is unique (`@HasUniqueExceptionDates()`). */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  hoursExceptions!: ListingHoursException[];

  // Always populated by the service (`ListingsService`'s `normalizeSocial`)
  // so every subfield is present (never omitted), mirroring
  // `PartnersService.normalizeContact`'s precedent.
  @Column({ type: 'jsonb', default: () => "'{}'" })
  social!: ListingSocial;

  /**
   * The listing's photos, in the order the owner arranged them. Index 0 is the
   * COVER. Each entry carries its own image reference, its own alt text and an
   * optional caption (see `ListingGalleryPhoto`), so a photo and its
   * description can never drift into different columns.
   *
   * This is the source of truth for every read and write path. Capped at
   * `MAX_LISTING_GALLERY_PHOTOS` by `CreateListingDto`'s `@ArrayMaxSize`.
   */
  @Column({ type: 'jsonb', default: () => "'[]'" })
  photoGallery!: ListingGalleryPhoto[];

  /**
   * LEGACY compatibility mirror of the first four `photoGallery` entries,
   * kept through the transition to the ordered gallery
   * (`AddListingPhotoGallery1794310000000` explains why the columns were kept
   * rather than dropped).
   *
   * DERIVED, never authored: every save rewrites both from `photoGallery` via
   * `legacySlotsFromGallery`. Do not read them to answer "what photos does this
   * listing have" — they cannot see past the fourth photo and they hold no
   * captions. Read `photoGallery`.
   */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  photos!: ListingPhotoSet;

  /** LEGACY alt-text mirror. See `photos` directly above. */
  @Column({ type: 'jsonb', default: () => "'{}'" })
  alt!: ListingPhotoSet;

  @Column({ type: 'varchar', default: '' })
  rel!: string;

  @Column({ type: 'varchar', default: '' })
  ownerName!: string;

  @Column({ type: 'varchar', default: '' })
  ownerRole!: string;

  @Column({ type: 'text', default: '' })
  ownerBio!: string;

  @Column({ type: 'varchar', default: '' })
  visibility!: string;

  @Column({ type: 'boolean', default: false })
  linkToProfile!: boolean;

  @Column({ type: 'varchar', default: '' })
  contactEmail!: string;

  /**
   * RETIRED: the owner's three notification preferences. No longer collected by
   * `CreateListingDto` and no longer served by any response builder, and no
   * send path ever consulted it: owners are notified regardless of what it
   * held. The column stays mapped so the values already stored on existing rows
   * are not destroyed. Do not add new writers.
   */
  @Column({ type: 'text', array: true, default: '{}' })
  notify!: string[];

  @Column({ type: 'boolean', default: false })
  consentOuting!: boolean;

  @Column({ type: 'boolean', default: false })
  consentGuide!: boolean;

  // --- Queer-owned verification (moderator-checked badge) ---
  // `linkToProfile` is the member's own self-reported claim of ownership; this
  // is the moderator's independent confirmation of it, mirroring
  // `safeSpaceStatus`'s "member submission vs. moderator-verified badge"
  // split. `false` by default and set only via the moderator toggle
  // (`PATCH /listings/:ref/queer-owned-verified`) — never touched by the
  // member-submission wizard, same convention as `isPartneredWithQueerpulse`.

  @Index('IDX_listings_queer_owned_verified')
  @Column({ type: 'boolean', default: false })
  queerOwnedVerified!: boolean;

  // --- Queer-owned verification provenance ---
  // Named and shaped after the `safeSpace*` columns above on purpose: the two
  // badges sit side by side on the same page and are supposed to read as
  // siblings. Before this, `safeSpaceVerifier`/`safeSpaceReVerifiedAt` showed a
  // reader exactly who checked a safe space and when, while the queer-owned
  // badge next to it was a bare boolean that looked every bit as authoritative
  // and was backed by nothing a reader could inspect.

  /** Who confirmed it, in the same free-text "Mod team · 2 visits" form
   * `safeSpaceVerifier` uses. Never left blank on a live grant: the toggle
   * endpoint falls back to the acting moderator's own name. */
  @Column({ type: 'varchar', default: '' })
  queerOwnedVerifier!: string;

  /** When it was last confirmed (`YYYY-MM-DD`), sibling of
   * `safeSpaceReVerifiedAt`. `null` while the badge has never been granted. */
  @Column({ type: 'date', nullable: true })
  queerOwnedReVerifiedAt!: string | null;

  /** What the confirmation rested on ("company register plus a call with the
   * owner"), sibling of `safeSpaceSub`. Empty when the moderator recorded no
   * basis. */
  @Column({ type: 'text', default: '' })
  queerOwnedBasis!: string;

  /**
   * When the badge next needs re-confirming (`YYYY-MM-DD`). A business can
   * quietly change hands, and a confirmation granted once should not still be
   * speaking for it years later. Past this date the badge stops reading as
   * verified on every public response while the record of the grant itself
   * stays exactly where it is: an expired badge is a badge that needs looking
   * at again, never a badge that was never granted.
   *
   * `null` means the grant carries no expiry at all (nothing pre-dating this
   * column is left in that state; the migration gave every existing grant a
   * date).
   */
  @Column({ type: 'date', nullable: true })
  queerOwnedExpiresAt!: string | null;

  // --- The affirming baseline ---

  /**
   * When the submitter agreed to the LGBTQ+ affirming baseline, which every
   * listing agrees to in order to appear in this directory at all.
   *
   * This is a MANDATORY universal baseline, matching the housing side's
   * pledge (`AffirmingPledgeService`): it is not an optional flag, not a
   * distinguishing attribute of one business versus another, and never a
   * filter members opt into. Rendering it as a per-listing chip or offering a
   * "only show affirming places" toggle would restate it as optional, which is
   * exactly what having a baseline is meant to end.
   *
   * What is being agreed to is a commitment to treat people decently: to
   * welcome and serve LGBTQ+ people, and to handle it when someone in the
   * space does not. That is a promise about the business's own conduct. It is
   * emphatically NOT a licence to turn anyone away over who they are, and it
   * must never be described, rendered or read as one.
   *
   * `null` only for a row written before the column existed and never
   * backfilled; the migration stamped every existing listing from its
   * `created_at`, so no live listing reads as never-agreed.
   */
  @Column({ type: 'timestamptz', nullable: true })
  affirmingBaselineAcceptedAt!: Date | null;

  // --- Owner pause (whether the LISTING is shown) ---

  /**
   * The owner has hidden their listing from the directory without deleting it.
   *
   * DISTINCT from `operatingState` above, and the two must never be folded
   * into each other. `operatingState` describes THE BUSINESS: whether it is
   * still trading, which is a fact about the world that a reader is entitled
   * to. This describes THE LISTING: whether the owner currently wants it
   * shown, which is a fact about their relationship with the directory. A
   * thriving business can hide its listing while it is short-staffed; a
   * permanently closed one can keep its listing up so its page and its reviews
   * stay where every existing link points. Neither implies the other.
   *
   * Everything survives: the row, its reviews, its photos, its moderation
   * history, its safe-space badge. Unhiding restores the listing exactly as it
   * was, which is the whole reason this exists. Owners were deleting listings
   * for reasons that were temporary, and a delete takes the reviews with it.
   *
   * The owner still reaches their own hidden listing through the owner-scoped
   * routes (`GET /listings/mine`, `GET /listings/:ref`), which is how they
   * unhide it.
   */
  @Index('IDX_listings_is_hidden_by_owner')
  @Column({ type: 'boolean', default: false })
  isHiddenByOwner!: boolean;

  /** When the owner hid it, so their own listing management view can say
   * "hidden since 4 March". `null` whenever the listing is shown. */
  @Column({ type: 'timestamptz', nullable: true })
  ownerHiddenAt!: Date | null;

  // --- Partner-space fields (host directory) ---
  // A listing flagged as a QueerPulse partner venue surfaces on the public
  // host page's "Partner spaces" card (`GET /directory/spaces`). These are an
  // ops/moderation decision, not part of the member-submission wizard, so they
  // default to unpartnered/empty and are set by seed or a future admin toggle.

  @Index('IDX_listings_is_partnered_with_queerpulse')
  @Column({ type: 'boolean', default: false })
  isPartneredWithQueerpulse!: boolean;

  /** Human venue type shown on the host card, e.g. "Warehouse". */
  @Column({ type: 'varchar', default: '' })
  spaceType!: string;

  /** Max guests the venue hosts ("up to N"); null when not specified. */
  @Column({ type: 'int', nullable: true })
  capacity!: number | null;

  /** Trailing qualifier on the host card, e.g. "events only". */
  @Column({ type: 'varchar', default: '' })
  hostNote!: string;

  // --- Safe-space fields (safety directory) ---
  // A listing a moderator has vetted as a safe space surfaces on the public
  // Safe Spaces page (`GET /directory/safe-spaces`). `none` by default; set by
  // the moderator toggle (`PATCH /listings/:ref/safe-space`) or seed.

  @Index('IDX_listings_safe_space_status')
  @Column({
    type: 'enum',
    enum: SafeSpaceStatus,
    enumName: 'listings_safe_space_status_enum',
    default: SafeSpaceStatus.None,
  })
  safeSpaceStatus!: SafeSpaceStatus;

  @Column({ type: 'int', nullable: true })
  safeSpaceTier!: number | null;

  @Column({ type: 'varchar', default: '' })
  safeSpaceVerifier!: string;

  @Column({ type: 'date', nullable: true })
  safeSpaceReVerifiedAt!: string | null;

  @Column({ type: 'text', default: '' })
  safeSpaceSub!: string;

  @Column({ type: 'jsonb', default: () => "'[]'" })
  safeSpacePromises!: SafeSpacePromise[];

  @Column({ type: 'jsonb', default: () => "'[]'" })
  safeSpaceVouches!: SafeSpaceVouch[];

  @Column({ type: 'jsonb', nullable: true })
  safeSpaceRemoval!: SafeSpaceRemoval | null;

  // --- Operating state (owned by the business, NOT by moderation) ---
  // `status` above says what MODERATION thinks of the listing; these say
  // whether the business is still trading. The two move independently: a
  // permanently closed venue stays a `live`, well-reviewed listing whose
  // detail page still resolves. Set only through the owner route
  // `PATCH /listings/:ref/operating-state`, which never touches `status`.

  // Indexed for the same reason `safeSpaceStatus` is: every public directory
  // read now carries an `operating_state <> 'permanently_closed'` predicate,
  // and the ops/owner surfaces filter on the closed values directly.
  @Index('IDX_listings_operating_state')
  @Column({
    type: 'enum',
    enum: ListingOperatingState,
    enumName: 'listings_operating_state_enum',
    default: ListingOperatingState.Open,
  })
  operatingState!: ListingOperatingState;

  /** The owner's short public explanation of the closure or move ("Closed for
   * refurbishment until September"). Empty while `operatingState` is `open`. */
  @Column({ type: 'text', default: '' })
  operatingStateNote!: string;

  /** When the current non-`open` state was declared, so the banner can read
   * "Temporarily closed since 4 March". `null` while the listing is `open`,
   * and re-stamped only when the state VALUE changes (editing the note keeps
   * the original date, which is the date a reader cares about). */
  @Column({ type: 'timestamptz', nullable: true })
  operatingStateSetAt!: Date | null;

  /** Where a `moved` business went, as free text. This is the common case:
   * the new premises are usually not a listing of their own. Empty
   * otherwise. */
  @Column({ type: 'text', default: '' })
  movedToAddress!: string;

  /** The successor listing in this same directory, when the moved business
   * already has one, so the banner can link straight to it. `null` whenever
   * there is no successor row (which is most `moved` listings). The FK is
   * `ON DELETE SET NULL`: deleting the successor must not delete its
   * predecessor's history. */
  @Column({ type: 'uuid', nullable: true })
  movedToListingId!: string | null;

  // --- Freshness ---

  /** When the owner last asserted that the listing's details are still true,
   * either by pressing "still accurate"
   * (`POST /listings/:ref/confirm-details`) or by making a real edit (editing
   * your details is confirming them). Distinct from `updatedAt`, which any
   * write moves, including moderator-only ones the owner never saw. `null`
   * only for a listing whose owner has never confirmed and never edited it.
   * Existing rows were backfilled from `updated_at` by the migration so no
   * live listing reads as never-confirmed. */
  @Column({ type: 'timestamptz', nullable: true })
  detailsConfirmedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz' })
  updatedAt!: Date;
}
