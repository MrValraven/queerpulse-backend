import { toImageUrl } from '../common/image-url';
import { ListingPublicQuestionDTO } from './dto/listing-public-question.dto';
import { MemberRef } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import type { CropRect } from '../media-crops/crop-rect';
import { cropFor } from '../media-crops/crop-response';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingDayHours,
  ListingHoursException,
  ListingOperatingState,
  ListingPhotoSet,
  ListingServiceOffering,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
  SafeSpacePromise,
  SafeSpaceRemoval,
  SafeSpaceVouch,
} from './entities/listing.entity';
import {
  ListingAccessibilityAnswerMap,
  normalizeAccessibilityAnswers,
} from './listing-accessibility';
import {
  galleryImageReferences,
  legacySlotsFromGallery,
} from './listing-photo-gallery';

/**
 * One photo of a listing's ordered gallery as every response carries it.
 *
 * Field names mirror `ListingGalleryPhotoDto` exactly, so the array a client
 * reads here is the array it PATCHes back: `image` arrives resolved through
 * `toImageUrl` (a `/files/<key>` URL for one of our uploads), and the upload
 * interceptor collapses that back to the bare key on the way in.
 *
 * `alt` and `caption` are always present and always separate. `alt` describes
 * the photo for someone who cannot see it; `caption` is copy shown to
 * everyone. Rendering one in place of the other is a bug in either direction.
 *
 * `crop` is absent (never a bare `undefined` key on the wire) when this photo
 * has no saved crop rect.
 */
export interface ListingGalleryPhotoView {
  image: string | null;
  alt: string;
  caption: string;
  crop?: CropRect;
}

/**
 * Maps a listing's stored gallery to its response shape, resolving each image
 * reference and attaching any pre-loaded crop rect.
 *
 * Stays synchronous: the caller batches ONE `MediaCropService.getMany` for a
 * whole page (see `listingPhotoKeys`) and passes the resulting Map through.
 */
export function toGalleryView(
  listing: Listing,
  crops: Map<string, CropRect> = new Map(),
): ListingGalleryPhotoView[] {
  return (listing.photoGallery ?? []).map((photo) => {
    const crop = cropFor(photo.image, crops);
    return {
      image: toImageUrl(photo.image),
      alt: photo.alt ?? '',
      caption: photo.caption ?? '',
      ...(crop ? { crop } : {}),
    };
  });
}

/**
 * The listing's cover photo (the first entry of its ordered gallery), or
 * `null` for a listing with no photos at all.
 */
export function toCoverPhoto(
  listing: Listing,
  crops: Map<string, CropRect> = new Map(),
): ListingGalleryPhotoView | null {
  return toGalleryView(listing, crops)[0] ?? null;
}

/**
 * LEGACY response-side shape of `photos`: four named slots, each `string |
 * null` because `toImageUrl('')` returns `null` for an empty slot.
 *
 * Superseded by `ListingGalleryPhotoView[]`, and still emitted (derived from
 * the first four gallery entries) so a frontend that has not moved to
 * `photoGallery` keeps rendering. It cannot see past the fourth photo and it
 * carries no captions.
 */
export interface ListingPhotoSetView {
  wide: string | null;
  d1: string | null;
  d2: string | null;
  vibe: string | null;
}

/** Per-slot crop rects for `ListingPhotoSetView` — a sibling map, not inline
 * on each slot, since `ListingPhotoSetView`'s fields are plain `string | null`
 * (mirrored verbatim by the frontend `ListingDraft` contract). A slot with no
 * saved crop is simply absent (never a bare `undefined` key on the wire). */
export interface ListingPhotoCropSetView {
  wide?: CropRect;
  d1?: CropRect;
  d2?: CropRect;
  vibe?: CropRect;
}

/** LEGACY per-slot crop lookup, derived from the first four gallery entries
 * so it agrees with `legacyPhotoSetView`. Same batching contract as
 * `toGalleryView`: the caller does ONE lookup for the whole page/detail. */
function toPhotoCrops(
  photos: ListingPhotoSet,
  crops: Map<string, CropRect>,
): ListingPhotoCropSetView {
  return {
    wide: cropFor(photos.wide, crops),
    d1: cropFor(photos.d1, crops),
    d2: cropFor(photos.d2, crops),
    vibe: cropFor(photos.vibe, crops),
  };
}

/**
 * Every raw stored reference (storage key or external URL) a listing's photos
 * are about to emit — collected BEFORE `toImageUrl` resolves them, so
 * `MediaCropService.getMany` can batch-resolve every crop for a page (or a
 * single listing) in ONE query.
 *
 * Reads the ordered gallery, which is the source of truth. The legacy
 * `photos` slots are a derived mirror of the first four entries, so they add
 * nothing here.
 */
export function listingPhotoKeys(listing: Listing): string[] {
  return galleryImageReferences(listing.photoGallery);
}

/** The legacy four-slot photo/alt pair a response still emits, derived from
 * the ordered gallery rather than read off the mirror columns, so the wire
 * shape agrees with `photoGallery` even for a row whose mirror has drifted. */
function legacyPhotoSets(listing: Listing): {
  photos: ListingPhotoSet;
  alt: ListingPhotoSet;
} {
  return legacySlotsFromGallery(listing.photoGallery ?? []);
}

/** The legacy `photos` response object (resolved URLs per named slot). */
function legacyPhotoSetView(photos: ListingPhotoSet): ListingPhotoSetView {
  return {
    wide: toImageUrl(photos.wide),
    d1: toImageUrl(photos.d1),
    d2: toImageUrl(photos.d2),
    vibe: toImageUrl(photos.vibe),
  };
}

/**
 * The business's own report of whether it is still trading, in the shape every
 * listing response carries it. Separate from the moderation `status`, and
 * separate again from any safe-space badge.
 *
 * `setAt` is an ISO-8601 instant (or `null` while the listing is `open`), so
 * the frontend composes the localized "Temporarily closed since 4 March" line
 * itself: the backend emits primitives, the same split `UpcomingEventDTO`
 * already follows.
 */
export interface OperatingStateView {
  state: ListingOperatingState;
  note: string | null;
  setAt: string | null;
  /** Free-text destination of a `moved` business. `null` for every other
   * state, and for a move whose destination was never written down. */
  movedToAddress: string | null;
}

/** Builds the shared operating-state view from a listing row. Reads the
 * supporting fields only for a non-`open` state, so a listing that reopened
 * can never leak the note or address of a closure it has left behind, even if
 * a stale value somehow survived on the row. */
export function operatingStateView(listing: Listing): OperatingStateView {
  const isOpen = listing.operatingState === ListingOperatingState.Open;
  return {
    state: listing.operatingState,
    note: isOpen ? null : listing.operatingStateNote || null,
    setAt: isOpen ? null : (listing.operatingStateSetAt?.toISOString() ?? null),
    movedToAddress:
      listing.operatingState === ListingOperatingState.Moved
        ? listing.movedToAddress || null
        : null,
  };
}

/**
 * The venue's accessibility answers as every listing response carries them.
 *
 * `answers` is always the COMPLETE question set: an unanswered question comes
 * back as an explicit `"unknown"`, never as a missing key. A client must be
 * able to render three distinct states — yes, no, and nobody has said — and it
 * can only do that if `no` and `unknown` arrive as different values. Do not
 * render `unknown` as a negative and do not drop it: "we have not been told"
 * is information a member planning around a wheelchair actually uses.
 *
 * `note` is the owner's free-text caveat ("two steps at the door"), or `null`
 * when they wrote none.
 */
export interface ListingAccessibilityView {
  answers: ListingAccessibilityAnswerMap;
  note: string | null;
}

/** Builds the shared accessibility view from a listing row, normalizing the
 * stored map up to the full vocabulary so a row written before a question
 * existed still answers it (as `unknown`). */
export function accessibilityView(listing: Listing): ListingAccessibilityView {
  return {
    answers: normalizeAccessibilityAnswers(listing.accessibilityAnswers),
    note: listing.accessibilityNote || null,
  };
}

/**
 * The listing's agreement to the LGBTQ+ affirming baseline, as every listing
 * response carries it.
 *
 * `isAccepted` is `true` on every listing in the directory, because agreeing
 * is the condition of appearing at all. It is here so a page can STATE the
 * commitment ("every business here has agreed to welcome and serve LGBTQ+
 * people"), not so a client can compare listings by it: it must not be
 * rendered as a per-listing badge that some places earn, and must not be
 * offered as a browse filter. Both would restate a baseline as an option,
 * which is the pattern the baseline replaced.
 *
 * The commitment is about the business's own conduct toward the people it
 * serves. It grants nobody permission to exclude anyone over who they are.
 */
export interface AffirmingBaselineView {
  isAccepted: boolean;
  acceptedAt: string | null;
}

export function affirmingBaselineView(listing: Listing): AffirmingBaselineView {
  return {
    isAccepted: listing.affirmingBaselineAcceptedAt !== null,
    acceptedAt: listing.affirmingBaselineAcceptedAt?.toISOString() ?? null,
  };
}

/**
 * Today as a `YYYY-MM-DD` string, for comparing against the `date`-typed
 * `queerOwnedExpiresAt` (which TypeORM hands back as a string, not a Date).
 * ISO date strings compare correctly with `<`, so no parsing is needed.
 */
function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * The evidence behind the queer-owned badge, shaped to read as a sibling of
 * the safe-space verification block it sits beside.
 *
 * `isGranted` is the RAW stored grant and deliberately stays `true` after the
 * badge expires: the record of who confirmed what, and when, is not deleted by
 * time passing. The EFFECTIVE badge is the separate top-level
 * `queerOwnedVerified` field, which is `isGranted && !isExpired`, so an expired
 * badge stops reading as verified everywhere a client renders it while the
 * moderation surface can still see that a lapsed grant exists and needs
 * looking at again.
 */
export interface QueerOwnedVerificationView {
  isGranted: boolean;
  isExpired: boolean;
  verifier: string | null;
  /** `YYYY-MM-DD` the confirmation was last made. */
  reVerifiedAt: string | null;
  basis: string | null;
  /** `YYYY-MM-DD` the confirmation next needs re-making. */
  expiresAt: string | null;
}

/** True when a granted badge has passed its re-confirmation date. A badge
 * that was never granted is never "expired" — it is simply absent. */
export function isQueerOwnedVerificationExpired(listing: Listing): boolean {
  if (!listing.queerOwnedVerified) return false;
  const expiresAt = listing.queerOwnedExpiresAt;
  return (
    expiresAt !== null && expiresAt !== undefined && expiresAt < todayIsoDate()
  );
}

/** The badge as it currently reads: granted, and not yet lapsed. This is the
 * value every `queerOwnedVerified` field on every response carries. */
export function isQueerOwnedCurrentlyVerified(listing: Listing): boolean {
  return (
    Boolean(listing.queerOwnedVerified) &&
    !isQueerOwnedVerificationExpired(listing)
  );
}

export function queerOwnedVerificationView(
  listing: Listing,
): QueerOwnedVerificationView {
  return {
    isGranted: Boolean(listing.queerOwnedVerified),
    isExpired: isQueerOwnedVerificationExpired(listing),
    // Empty text columns read as "no value", the same `|| null` idiom the
    // safe-space fields use.
    verifier: listing.queerOwnedVerifier || null,
    reVerifiedAt: listing.queerOwnedReVerifiedAt ?? null,
    basis: listing.queerOwnedBasis || null,
    expiresAt: listing.queerOwnedExpiresAt ?? null,
  };
}

/**
 * Whether the owner is currently showing their listing in the directory.
 *
 * Owner-facing only: a hidden listing never reaches a public response at all,
 * so there is nothing for the public DTOs to carry. Kept strictly apart from
 * `OperatingStateView`, which answers the different question of whether the
 * BUSINESS is trading.
 */
export interface DirectoryVisibilityView {
  isHiddenByOwner: boolean;
  hiddenAt: string | null;
}

export function directoryVisibilityView(
  listing: Listing,
): DirectoryVisibilityView {
  const isHiddenByOwner = Boolean(listing.isHiddenByOwner);
  return {
    isHiddenByOwner,
    hiddenAt: isHiddenByOwner
      ? (listing.ownerHiddenAt?.toISOString() ?? null)
      : null,
  };
}

/**
 * The successor listing a `moved` business points at, resolved to the two
 * fields a link needs. `null` whenever there is no successor row, or the
 * successor is not publicly reachable (not live, or itself permanently
 * closed), so the banner never offers a link that 404s.
 */
export interface MovedToListingView {
  slug: string;
  name: string;
}

/**
 * `ListingDTO` — matches the frontend's `ListingDTO` in
 * `listings.api.ts` exactly: every `ListingDraft` field spread flat, plus
 * `ref`/`slug`/`status`/`submittedBy`/`createdAt`.
 */
export interface ListingDTO {
  ref: string;
  slug: string;
  status: ListingStatus;
  submittedBy: MemberRef | null;
  createdAt: string;

  path: string;
  name: string;
  cats: string[];
  hood: string;
  badge: string;
  evidence: string;
  price: string;
  blurb: string;
  tagline: string;
  whatItIs: ListingWitLine[];
  tags: string[];
  /** Atmosphere tags only. Access claims live on `accessibility` below. */
  goodFor: string[];
  /** The venue's structured accessibility answers plus its free-text note.
   * Every question is present, `unknown` included. */
  accessibility: ListingAccessibilityView;
  /** What the business sells and what it costs. Empty when it prices
   * nothing. The single `price` band above is unchanged. */
  services: ListingServiceOffering[];
  langs: string[];
  /** Online-only business (no physical location). */
  online: boolean;
  address: string;
  geocoded: boolean;
  latitude: number | null;
  longitude: number | null;
  hours: Record<string, ListingDayHours>;
  hoursNote: string;
  /** Per-date overrides of the weekly `hours` grid (holidays, early closes).
   * Same shape the owner PATCHes back. */
  hoursExceptions: ListingHoursException[];
  social: ListingSocial;
  /** The listing's photos, in the owner's chosen order. Index 0 is the cover.
   * Each entry carries its own `alt` (accessibility description) and its own
   * `caption` (copy shown to everyone). See `ListingGalleryPhotoView`. */
  photoGallery: ListingGalleryPhotoView[];
  /** LEGACY four-slot view, derived from the first four `photoGallery`
   * entries. Superseded by `photoGallery`; it cannot represent a fifth photo,
   * an owner-chosen order or a caption. */
  photos: ListingPhotoSetView;
  /** LEGACY per-slot crop rects for `photos`, see `ListingPhotoCropSetView`.
   * Superseded by each `photoGallery` entry's own `crop`. */
  photoCrops: ListingPhotoCropSetView;
  /** LEGACY per-slot alt text, derived from the first four `photoGallery`
   * entries. Superseded by each entry's own `alt`. */
  alt: ListingPhotoSet;
  rel: string;
  ownerName: string;
  ownerRole: string;
  ownerBio: string;
  visibility: string;
  linkToProfile: boolean;
  contactEmail: string;
  consentOuting: boolean;
  consentGuide: boolean;
  /** Moderator-verified confirmation of the "queer-owned" badge as it
   * CURRENTLY reads — distinct from `linkToProfile` (the member's own
   * self-reported claim). `false` once the grant has passed its
   * re-confirmation date, even though the grant itself is still on record
   * (see `queerOwnedVerification`). Surfaced here too (alongside the public
   * directory card/detail DTOs) so the general admin listings queue — which
   * reads/writes this owner-facing shape, not the public directory one — can
   * render and toggle it. */
  queerOwnedVerified: boolean;
  /** Who confirmed the queer-owned badge, when, on what basis, and when it
   * next needs re-confirming. Carries `isGranted` (the raw record, which
   * outlives expiry) alongside `isExpired`, so the moderation queue can tell
   * a lapsed badge from one that was never granted. */
  queerOwnedVerification: QueerOwnedVerificationView;
  /** The listing's agreement to the LGBTQ+ affirming baseline. True on every
   * listing: agreeing is the condition of appearing. State the commitment;
   * never render it as a distinguishing per-listing badge or a filter. */
  affirmingBaseline: AffirmingBaselineView;
  /** The business's own trading state, owned by the owner rather than by
   * moderation. Never mirrors or affects `status` above. */
  operatingState: OperatingStateView;
  /** Whether the owner is currently showing this listing in the directory.
   * A separate question from `operatingState` (is the business trading) and
   * from `status` (what moderation thinks). Owner-facing only. */
  directoryVisibility: DirectoryVisibilityView;
  /** The successor listing's id when a `moved` business points at one, so the
   * owner form can round-trip what it set. `null` otherwise. The public
   * detail DTO resolves this to a slug/name instead. */
  movedToListingId: string | null;
  /** When the owner last asserted these details are still true, ISO-8601.
   * `null` only if they never have. */
  detailsConfirmedAt: string | null;
}

/**
 * The answer to `POST /listings/:ref/confirm-details`. Deliberately tiny: the
 * button is meant to be pressed often, so the route reads one row to check
 * ownership, writes one column, and returns just the new stamp rather than
 * rebuilding the whole listing payload (which costs a member lookup and a crop
 * lookup on top).
 */
export interface ConfirmedDetailsDTO {
  ref: string;
  detailsConfirmedAt: string;
}

/**
 * One near-duplicate the wizard's live dedupe check surfaces (item #5,
 * `GET /listings/similar`). Deliberately tiny — the frontend only needs to
 * show "we already have a listing like this" with a link, so this leaks no
 * owner/contact/moderation fields. `cat` is the listing's PRIMARY category
 * slug (`cats[0]`); `distanceM` is the metres between the query coordinates
 * and this listing's pin, or `null` when either side has no coordinates.
 */
export interface SimilarListingDTO {
  name: string;
  cat: string;
  hood: string;
  slug: string;
  distanceM: number | null;
}

export function toSimilarListing(
  listing: Listing,
  distanceM: number | null,
): SimilarListingDTO {
  return {
    name: listing.name,
    cat: listing.cats[0] ?? '',
    hood: listing.hood,
    slug: listing.slug,
    distanceM,
  };
}

/**
 * Compact card for the public host page's "Partner spaces" list
 * (`GET /directory/spaces`). Deliberately NOT the full `ListingDTO`: the host
 * sidebar renders only venue-identity + capacity primitives, and this is a
 * `@Public()` surface, so it must not leak owner/contact/moderation fields.
 * `capacity` stays a raw int — the frontend composes the localized
 * "up to N" string (presentation split: backend emits primitives).
 */
export interface PartnerSpaceDTO {
  slug: string;
  hood: string;
  name: string;
  spaceType: string;
  capacity: number | null;
  hostNote: string;
}

export function toPartnerSpace(listing: Listing): PartnerSpaceDTO {
  return {
    slug: listing.slug,
    hood: listing.hood,
    name: listing.name,
    spaceType: listing.spaceType,
    capacity: listing.capacity,
    hostNote: listing.hostNote,
  };
}

/** Card avatar tint — a presentation primitive the frontend maps to colours. */
export type DirectoryTint = 'coral' | 'jade' | 'plum';

const DIRECTORY_TINTS: DirectoryTint[] = ['coral', 'jade', 'plum'];

/** Stable per-listing tint so a card keeps the same colour across requests. */
function tintForSlug(slug: string): DirectoryTint {
  let hash = 0;
  for (const char of slug) {
    hash = (hash + char.charCodeAt(0)) % DIRECTORY_TINTS.length;
  }
  // invariant: `hash` is kept in `[0, DIRECTORY_TINTS.length)` by the
  // `% DIRECTORY_TINTS.length` in the loop, so it is always a valid index of
  // the non-empty DIRECTORY_TINTS constant.
  return DIRECTORY_TINTS[hash]!;
}

/** Two-letter avatar initials from the business name (e.g. "Galeria Lume" → "GL"). */
function initialsForName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  const firstWord = words[0] ?? '';
  if (words.length === 1) return firstWord.slice(0, 2).toUpperCase();
  const secondWord = words[1] ?? '';
  return ((firstWord[0] ?? '') + (secondWord[0] ?? '')).toUpperCase();
}

/** First name of the owner, for the "run by <first>" card line. */
function ownerFirstName(ownerName: string): string {
  return (
    ownerName
      .trim()
      .split(/[\s&·]+/)
      .filter(Boolean)[0] ?? ''
  );
}

/**
 * The owner's public-facing identity, redacted to honour the visibility they
 * chose in the listing wizard (`create-listing.dto.ts`: `public | role | anon`).
 *
 * This MUST live here, in the response builder, because the public directory
 * DTOs (`DirectoryCardDTO`/`DirectoryDetailDTO`) carry no `visibility` field —
 * the client has nothing to redact on. The wizard's own preview honours the
 * choice, but that is cosmetic; `GET /directory[/:slug]` is the real boundary,
 * and before this it returned the owner's real name/first-name/profile-link
 * even when they picked "anonymous", outing a person who opted out.
 *
 * - `anon`: reveal nothing that identifies the owner.
 * - `role`: show the role, never the real name, first name, or a profile link
 *   (the "view profile"/"run by <first>" affordances each name the person).
 * - `public` (and any unset/legacy value): full identity, still gated by the
 *   separate `linkToProfile` consent for the profile link.
 */
interface OwnerIdentityView {
  name: string;
  role: string;
  bio: string;
  first: string;
  inQueerPulse: boolean;
}

function ownerIdentity(listing: Listing): OwnerIdentityView {
  if (listing.visibility === 'anon') {
    return { name: '', role: '', bio: '', first: '', inQueerPulse: false };
  }
  if (listing.visibility === 'role') {
    return {
      name: listing.ownerRole,
      role: '',
      bio: listing.ownerBio,
      first: '',
      inQueerPulse: false,
    };
  }
  return {
    name: listing.ownerName,
    role: listing.ownerRole,
    bio: listing.ownerBio,
    first: ownerFirstName(listing.ownerName),
    inQueerPulse: listing.linkToProfile,
  };
}

/**
 * Compact card for the public `/local/directory` grid (`GET /directory`).
 * `tint`/`av` are presentation primitives (colour + initials); the frontend
 * resolves the category label and badge copy. `memberFirst` is non-null only
 * when the listing is linked to its owner's QueerPulse profile — the grid uses
 * it to show the "run by a member" line.
 */
export interface DirectoryCardDTO {
  /** The listing's real DB uuid — distinct from `ref` (the human-readable
   * mutation-path id) and `slug` (the cosmetic public URL id). Exposed so a
   * cross-entity FK (e.g. a gathering's `Event.listingId`) can target a real
   * listing picked from this public card grid — mirrors `UpcomingEventDTO.id`
   * already exposed on this same detail payload. */
  id: string;
  slug: string;
  name: string;
  cat: string;
  hood: string;
  blurb: string;
  tint: DirectoryTint;
  av: string;
  owned: boolean;
  /** Moderator-verified confirmation of the "queer-owned" badge as it
   * CURRENTLY reads — distinct from `owned` (the member's own self-reported
   * `linkToProfile` claim). `false` until a moderator explicitly confirms it
   * (`PATCH /admin/listings/:ref/queer-owned-verified`), and `false` again
   * once that confirmation passes its re-confirmation date: a badge granted
   * years ago must not go on speaking for a business that may have changed
   * hands. `DirectoryDetailDTO` inherits this via `extends DirectoryCardDTO`
   * — no separate detail mapping needed. */
  queerOwnedVerified: boolean;
  memberFirst: string | null;
  /** Online-only business (no physical location) — the card shows an "Online"
   *  badge instead of a neighbourhood and never pins the map. */
  online: boolean;
  // Map pin, when the owner placed one while listing. null ⇒ list-only (no pin).
  latitude: number | null;
  longitude: number | null;
  // Safe-space badge primitives for the card. Deliberately lean — detail-only
  // fields (promises/vouches/removal/verifier/re-verified-at) are NOT surfaced
  // here; see `SafeSpaceDetailDTO`/`RemovedSpaceDetailDTO` for those.
  safeSpaceStatus: 'none' | 'verified' | 'removed';
  safeSpaceTier: number | null;
  /** The business's own trading state, so a card can badge "Temporarily
   * closed" or "Moved" without a second request. A `permanently_closed`
   * listing never reaches a card list at all (`DirectoryService` filters it
   * out); the value can still be seen here through `DirectoryDetailDTO`,
   * which inherits this shape and does still resolve for a closed business. */
  operatingState: OperatingStateView;
  /** The listing's cover photo: the FIRST entry of its ordered gallery, which
   * is the one the owner put first. `null` for a listing with no photos, which
   * is when the card falls back to its `tint` + `av` initials. Carries the
   * photo's own `alt` so the grid image is never unlabelled. */
  coverPhoto: ListingGalleryPhotoView | null;
}

export function toDirectoryCard(
  listing: Listing,
  // Pre-loaded crop lookup (see `listingPhotoKeys`) so `coverPhoto` can carry
  // its saved crop rect. Defaulted, so a caller that does not render crops
  // stays a one-argument call. NOTE: never pass this mapper straight to
  // `Array.prototype.map` — the index would arrive here as the crop Map.
  crops: Map<string, CropRect> = new Map(),
): DirectoryCardDTO {
  const owner = ownerIdentity(listing);
  return {
    id: listing.id,
    slug: listing.slug,
    name: listing.name,
    cat: listing.cats[0] ?? '',
    hood: listing.hood,
    blurb: listing.blurb,
    tint: tintForSlug(listing.slug),
    av: initialsForName(listing.name),
    // A listing linked to its owner's member profile is a community-owned
    // ("queer-owned") business; unlinked ones are allied/"friendly" venues.
    owned: listing.linkToProfile,
    queerOwnedVerified: isQueerOwnedCurrentlyVerified(listing),
    // The "run by <first>" line names the owner, so it follows their chosen
    // visibility — null for `anon`/`role` (where `owner.first` is blank).
    memberFirst: listing.linkToProfile ? owner.first || null : null,
    online: listing.online ?? false,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    safeSpaceStatus: listing.safeSpaceStatus,
    safeSpaceTier: listing.safeSpaceTier ?? null,
    operatingState: operatingStateView(listing),
    coverPhoto: toCoverPhoto(listing, crops),
  };
}

/** Opening-hours template the frontend renders (mirrors FE `HoursType`). */
export type DirectoryHoursType =
  | 'cafe'
  | 'restaurant'
  | 'bar'
  | 'clinic'
  | 'shop'
  | 'gym'
  | 'gallery'
  | 'appointment'
  | 'studio';

// The listing model stores per-day hours, but the directory detail page renders
// from a category-shaped weekly template (FE `hoursRows(hoursType)`). Map the
// primary category to the closest template; anything unmapped falls back to
// "appointment" (the neutral "message to arrange" template).
const CATEGORY_HOURS_TYPE: Record<string, DirectoryHoursType> = {
  food: 'restaurant',
  design: 'studio',
  culture: 'gallery',
  tech: 'studio',
  grooming: 'shop',
  fitness: 'gym',
  health: 'clinic',
  space: 'studio',
  nightlife: 'restaurant',
};

function hoursTypeForCategory(cat: string): DirectoryHoursType {
  return CATEGORY_HOURS_TYPE[cat] ?? 'appointment';
}

/** A "good for" bullet — the listing stores positive bullets only. */
export interface DirectoryGoodFor {
  label: string;
  yes: boolean;
}

/** Who-runs-it card. Presentation primitives (`initials`, `tint`) come from the server. */
export interface DirectoryOwner {
  name: string;
  initials: string;
  tint: DirectoryTint;
  role: string;
  bio: string;
  inQueerPulse: boolean;
  first: string;
  /** The owner's public profile slug, for the "View profile" deep link —
   * present only when they linked their profile AND their chosen visibility
   * exposes their identity (`public`). `null` otherwise (anon/role/unlinked),
   * where the frontend hides the profile link. Resolved by the directory
   * service from `ownerId`; never derived from a display name. */
  slug: string | null;
  /** The owner's real profile photo, for the "Who runs it" card — same
   * gating as `slug` (public + profile-linked only). `null` otherwise, or
   * when the profile has no photo, and the frontend falls back to the
   * tinted `initials` avatar. */
  avatarUrl: string | null;
}

/**
 * An upcoming event at a listing's venue. `startAt` is an ISO timestamp — the
 * frontend composes the localized "Sat 21 Jun · 20:00" line (presentation
 * split), so the server never bakes in an English date string.
 */
export interface UpcomingEventDTO {
  id: string;
  slug: string;
  startAt: string;
  title: string;
}

export function toUpcomingEvent(event: Event): UpcomingEventDTO {
  return {
    id: event.id,
    slug: event.slug,
    startAt: event.startAt.toISOString(),
    title: event.title,
  };
}

/** The listing owner's single public reply to a review, present only once
 * one has been posted (`PATCH /listings/:ref/reviews/:reviewId/reply`). */
export interface ReviewOwnerReplyDTO {
  text: string;
  at: string;
}

/** The reviewer's live profile identity, resolved from `review.reviewerId`.
 * Present only for member-authored reviews whose author still has a profile;
 * seeded/imported reviews (null `reviewerId`) and members without a profile
 * resolve to `null`, and the row then renders with initials only, unlinked. */
export interface ReviewAuthor {
  slug: string;
  avatarUrl: string | null;
}

/** One review row on the detail page. `initials`/`tint` are server-derived. */
export interface ReviewDTO {
  /** The review's uuid PK — targets `PATCH :ref/reviews/:reviewId/reply`
   * (owner), `PATCH /directory/:slug/reviews/:reviewId` (the reviewer), and
   * `POST/DELETE /directory/:slug/reviews/:reviewId/helpful` (any member). */
  id: string;
  initials: string;
  name: string;
  tint: DirectoryTint;
  byline: string;
  stars: number;
  text: string;
  /**
   * When the review was written, ISO-8601.
   *
   * The column has existed since the table did and was simply never exposed,
   * which left every review on the page undated. That reads as a fairness
   * problem before it reads as an information one: a complaint from two years
   * and one refurbishment ago sits at the top of a business's page looking
   * exactly as current as one from last week, and the business has no way to
   * say otherwise. A reader deciding where to go needs the same date.
   */
  createdAt: string;
  /** When the reviewer last changed it, ISO-8601, or `null` if never. */
  editedAt: string | null;
  /**
   * True when `editedAt` is later than `ownerRepliedAt` — the review was
   * changed AFTER the owner answered it, so the reply on screen may be
   * answering words that are no longer there. Precomputed here rather than
   * left as a timestamp comparison for each client to get right (or not).
   * Always `false` when there is no reply or no edit.
   */
  isEditedAfterOwnerReply: boolean;
  helpful: number;
  /** The reviewer's optional photo, resolved to a fetchable URL. */
  photoUrl: string | null;
  ownerReply: ReviewOwnerReplyDTO | null;
  /** Reviewer's profile photo, when they are a member with one. `null` → the
   * frontend falls back to the tinted `initials` avatar. */
  avatarUrl: string | null;
  /** Reviewer's profile slug, when they are a member. `null` → the frontend
   * renders the name as plain text (seeded/non-member review); when set it
   * links to `/members/:authorSlug`. */
  authorSlug: string | null;
}

/**
 * Was this review changed after its owner reply was written?
 *
 * The two timestamps are independent and either can move, so the comparison is
 * done once, here, and shipped as a boolean. A review with no reply, or a reply
 * with no subsequent edit, is `false`.
 */
function isEditedAfterOwnerReply(review: ListingReview): boolean {
  if (!review.ownerReplyText || !review.ownerRepliedAt || !review.editedAt) {
    return false;
  }
  return review.editedAt.getTime() > review.ownerRepliedAt.getTime();
}

export function toReviewDTO(
  review: ListingReview,
  author: ReviewAuthor | null = null,
): ReviewDTO {
  return {
    id: review.id,
    initials: initialsForName(review.reviewerName),
    name: review.reviewerName,
    tint: tintForSlug(review.reviewerName),
    byline: review.byline,
    stars: review.stars,
    text: review.text,
    createdAt: review.createdAt.toISOString(),
    editedAt: review.editedAt ? review.editedAt.toISOString() : null,
    isEditedAfterOwnerReply: isEditedAfterOwnerReply(review),
    helpful: review.helpful,
    photoUrl: toImageUrl(review.photo),
    ownerReply: review.ownerReplyText
      ? {
          text: review.ownerReplyText,
          at: review.ownerRepliedAt!.toISOString(),
        }
      : null,
    avatarUrl: author?.avatarUrl ?? null,
    authorSlug: author?.slug ?? null,
  };
}

/**
 * How many public questions the DETAIL read embeds. Small on purpose: the Q&A
 * block is one section of a long page, the answer to the question a reader
 * actually has is usually recent, and the full list is one request away at
 * `GET /directory/:slug/questions`. Deliberately far below `DEFAULT_LIST_LIMIT`
 * (200), which the review array uses because the page derives its star rating
 * from that array and a truncated one would skew it. Nothing is derived from
 * the questions, so nothing breaks by capping them tightly.
 */
export const DIRECTORY_DETAIL_QUESTION_LIMIT = 10;

/**
 * What a helpful-vote write answers with: the review it was cast on, the
 * refreshed count, and whether THIS caller's vote now stands.
 *
 * `hasVoted` is deliberately absent from every public read. `GET /directory/:slug`
 * and `GET /directory/:slug/reviews` are `@Public()` and carry
 * `Cache-Control: public, s-maxage=60`, so a CDN answers them for everyone from
 * one stored copy. A per-caller field on those responses would be served to the
 * next reader as if it were theirs. The vote write is the only place the answer
 * is caller-specific, so it is the only place the answer is returned.
 */
export interface ReviewHelpfulDTO {
  reviewId: string;
  helpful: number;
  hasVoted: boolean;
}

/** Aggregate star rating for a listing: mean to one decimal + review count. */
export function ratingFromReviews(reviews: ListingReview[]): {
  score: string;
  count: number;
} {
  if (reviews.length === 0) return { score: '0', count: 0 };
  const total = reviews.reduce((sum, review) => sum + review.stars, 0);
  return {
    score: (total / reviews.length).toFixed(1),
    count: reviews.length,
  };
}

/**
 * Full detail payload for `/local/directory/:slug` (`GET /directory/:slug`).
 * `rating`/`reviews` are aggregated from `listing_reviews`; `upcoming` is added
 * when events link to listings. The frontend presence-guards the upcoming
 * section, so this renders cleanly before that lands.
 */
export interface DirectoryDetailDTO extends DirectoryCardDTO {
  /** The listing's human-readable business reference (e.g. `QPL-2026-0007`) —
   * the same id the owner-facing mutation paths address (`GET/PATCH/DELETE
   * /listings/:ref`, `POST /listings/:ref/dispute`). Surfaced on the detail
   * (not the card/grid) so a non-owner viewing a listing can address the
   * report/dispute endpoint. Read-only, non-sensitive reference id. */
  ref: string;
  tagline: string;
  /** City the venue sits in; `null` ⇒ the frontend defaults to Lisbon. */
  city: string | null;
  /** IANA timezone the hours run on; `null` ⇒ the frontend defaults to
   * Europe/Lisbon for its "Open now" computation. */
  timezone: string | null;
  pills: string[];
  /** LEGACY caption strip: one string per photo, its `caption` when it has one
   * and its `alt` otherwise. Kept as the fallback the prototype rendered for
   * listings/demo places without images. Superseded by `photoGallery`, where
   * caption and alt stay the separate things they are. */
  gallery: string[];
  /** The listing's photos, in the owner's chosen order. Index 0 is the cover.
   * Each entry carries its own image URL, alt text, optional caption and crop
   * rect. See `ListingGalleryPhotoView`. */
  photoGallery: ListingGalleryPhotoView[];
  /** LEGACY four-slot view, derived from the first four `photoGallery`
   * entries. `null` per empty slot. Superseded by `photoGallery`. */
  photos: ListingPhotoSetView;
  /** LEGACY per-slot crop rects for `photos`, see `ListingPhotoCropSetView`.
   * Superseded by each `photoGallery` entry's own `crop`. */
  photoCrops: ListingPhotoCropSetView;
  /** LEGACY per-slot alt text. Superseded by each entry's own `alt`. */
  alt: ListingPhotoSet;
  /** Real per-weekday opening hours, keyed by the FE `DAYS` id (`Mon`..`Sun`).
   * The FE computes an open/closed status from this; empty → status unknown. */
  hours: Record<string, ListingDayHours>;
  /** Per-date overrides of `hours` (holidays, early closes), newest date
   * last. The frontend does the "open now" arithmetic: an entry whose `date`
   * is today overrides that weekday's grid entry outright. */
  hoursExceptions: ListingHoursException[];
  langs: string[];
  whatItIs: string[];
  /** Atmosphere bullets only, every one a positive check. Accessibility is no
   * longer in here: it moved to `accessibility` below, which can answer no. */
  goodFor: DirectoryGoodFor[];
  /** The venue's structured accessibility answers plus its free-text note.
   * All six questions are always present; `unknown` is a real answer and must
   * not be rendered as a negative or dropped. */
  accessibility: ListingAccessibilityView;
  /** What the business sells and what it costs, in the owner's own words
   * ("from 25 EUR", "sliding scale"). Empty when it prices nothing. The
   * inherited `pills` still lead with the at-a-glance `price` band. */
  services: ListingServiceOffering[];
  /** The listing's agreement to the LGBTQ+ affirming baseline, so the page can
   * state the commitment every business here has made. `isAccepted` is true on
   * every listing by definition; it is not a distinguishing badge and not a
   * filter. */
  affirmingBaseline: AffirmingBaselineView;
  /** Who confirmed the queer-owned badge, when, on what basis, and when it
   * lapses — the same kind of evidence the safe-space block beside it carries,
   * so two badges that look equally authoritative can be checked equally. */
  queerOwnedVerification: QueerOwnedVerificationView;
  hoursType: DirectoryHoursType;
  hoursNote: string;
  owner: DirectoryOwner;
  social: ListingSocial;
  address: string;
  rating: { score: string; count: number };
  reviews: ReviewDTO[];
  /**
   * The listing's public Q&A, newest first and capped at
   * `DIRECTORY_DETAIL_QUESTION_LIMIT`, each with its answer inline.
   *
   * Capped rather than paginated here because this is the detail read, which
   * already assembles reviews, events, vouches, crops, a saved count and a
   * moved-to lookup. The full history is served separately by
   * `GET /directory/:slug/questions`, exactly as `GET /directory/:slug/reviews`
   * serves the full review list.
   */
  questions: ListingPublicQuestionDTO[];
  upcoming: UpcomingEventDTO[];
  /** Count of `saved_item` rows bookmarking this listing (`SavedKind.Listing`,
   * keyed by slug) — the public "N members saved this" trust signal. */
  savedCount: number;
  // Trust block, present alongside the inherited `safeSpaceStatus`/
  // `safeSpaceTier` so the merged directory detail page can render the full
  // safe-space narrative from the same record. Shapes mirror the raw
  // `Listing` columns exactly — the same source `toSafeSpaceDetail` (below)
  // reads for the safe-spaces hub — rather than the hub's own derived
  // `SafeSpaceDetailDTO` (which adds per-vouch `initials`/`tint`). `null`
  // whenever the listing has never been a verified/removed safe space.
  safeSpaceVerifier: string | null;
  safeSpaceReVerifiedAt: string | null;
  safeSpaceSub: string | null;
  safeSpacePromises: SafeSpacePromise[];
  safeSpaceVouches: SafeSpaceVouch[];
  safeSpaceRemoval: SafeSpaceRemoval | null;
  /** The successor listing of a `moved` business, resolved to a slug and name
   * so the banner can link to it. `null` unless the state is `moved`, the
   * owner pointed at a successor, and that successor is still publicly
   * reachable. The address itself lives on the inherited
   * `operatingState.movedToAddress`. */
  movedToListing: MovedToListingView | null;
  /** When the owner last confirmed these details are still true, ISO-8601, so
   * the page can print "Confirmed by the owner on 12 August". `null` only for
   * a listing whose owner has never confirmed and never edited it. */
  detailsConfirmedAt: string | null;
}

export function toDirectoryDetail(
  listing: Listing,
  reviews: ListingReview[],
  upcomingEvents: Event[],
  savedCount: number,
  /** Reviewer identities keyed by `reviewerId`, so member-authored reviews can
   * carry a profile avatar + link. Missing keys (seeded/non-member reviews)
   * render with initials only — see `toReviewDTO`. */
  reviewAuthors: Map<string, ReviewAuthor> = new Map(),
  /** The owner's resolved public profile slug (directory service looks it up
   * from `ownerId`), or `null` when the owner isn't linked/public. */
  ownerSlug: string | null = null,
  /** The owner's resolved profile photo (directory service looks it up from
   * `ownerId` alongside `ownerSlug`), or `null` when unlinked/no photo. */
  ownerAvatarUrl: string | null = null,
  /** Normalized member-written safe-space vouches (from the
   * `safe_space_member_vouches` table), already resolved to the raw
   * `SafeSpaceVouch` shape by `DirectoryService`. Merged AFTER the curated
   * jsonb vouches so both surface on the detail page. */
  memberVouches: SafeSpaceVouch[] = [],
  // Pre-loaded crop lookup for the four `photos` slots — the caller batches
  // ONE `MediaCropService.getMany` (see `listingPhotoKeys`) and passes the
  // resulting Map straight through; this mapper stays synchronous.
  crops: Map<string, CropRect> = new Map(),
  /** The successor listing of a `moved` business, already resolved (and
   * visibility-checked) by `DirectoryService`. `null` for every other case. */
  movedToListing: MovedToListingView | null = null,
  /** The public Q&A block, already loaded, moderation-filtered, capped and
   * mapped by `DirectoryService`. Defaulted to `[]` so the existing callers and
   * specs that do not pass it keep compiling and rendering an empty block. */
  questions: ListingPublicQuestionDTO[] = [],
): DirectoryDetailDTO {
  const tint = tintForSlug(listing.slug);
  const galleryPhotos = toGalleryView(listing, crops);
  const legacyPhotos = legacyPhotoSets(listing);
  return {
    ...toDirectoryCard(listing, crops),
    ref: listing.ref,
    tagline: listing.tagline,
    // Empty text columns read as "unset" (frontend then defaults to Lisbon /
    // Europe-Lisbon), same `|| null` idiom the safe-space fields below use.
    city: listing.city || null,
    timezone: listing.timezone || null,
    // Price tier first (when set), then the listing's own tags, as detail pills.
    pills: [...(listing.price ? [listing.price] : []), ...listing.tags],
    // LEGACY caption strip (the prototype rendered caption cells, no images).
    // A photo's own `caption` when it has one, its `alt` otherwise, in gallery
    // order, with nothing to say dropped.
    gallery: galleryPhotos
      .map((photo) => photo.caption || photo.alt)
      .filter((text) => text.length > 0),
    photoGallery: galleryPhotos,
    photos: legacyPhotoSetView(legacyPhotos.photos),
    photoCrops: toPhotoCrops(legacyPhotos.photos, crops),
    alt: legacyPhotos.alt,
    hours: listing.hours,
    hoursExceptions: listing.hoursExceptions ?? [],
    langs: listing.langs,
    whatItIs: listing.whatItIs.map((line) => line.text),
    // Atmosphere tags are stored as positive claims only, so every one is a
    // "yes". Anything that can also be answered "no" belongs in
    // `accessibility` below rather than here.
    goodFor: listing.goodFor.map((label) => ({ label, yes: true })),
    accessibility: accessibilityView(listing),
    services: listing.services ?? [],
    affirmingBaseline: affirmingBaselineView(listing),
    queerOwnedVerification: queerOwnedVerificationView(listing),
    hoursType: hoursTypeForCategory(listing.cats[0] ?? ''),
    hoursNote: listing.hoursNote,
    // Redacted per the owner's chosen `visibility` — `anon` reveals nothing,
    // `role` shows only the role. Initials derive from the already-redacted
    // name so they can't leak the real name's initials for an anon owner.
    owner: (() => {
      const identity = ownerIdentity(listing);
      return {
        name: identity.name,
        initials: initialsForName(identity.name),
        tint,
        role: identity.role,
        bio: identity.bio,
        inQueerPulse: identity.inQueerPulse,
        first: identity.first,
        // Only a public, profile-linked owner exposes a clickable profile — the
        // caller passes null for anon/role/unlinked, matching `inQueerPulse`.
        slug: identity.inQueerPulse ? ownerSlug : null,
        avatarUrl: identity.inQueerPulse ? ownerAvatarUrl : null,
      };
    })(),
    social: listing.social,
    address: listing.address,
    rating: ratingFromReviews(reviews),
    reviews: reviews.map((review) =>
      toReviewDTO(
        review,
        review.reviewerId
          ? (reviewAuthors.get(review.reviewerId) ?? null)
          : null,
      ),
    ),
    questions,
    upcoming: upcomingEvents.map(toUpcomingEvent),
    savedCount,
    // Empty-string defaults (never-a-safe-space listings) read as "no value"
    // here, same as `safeSpaceTier` already does on the inherited card DTO.
    safeSpaceVerifier: listing.safeSpaceVerifier || null,
    safeSpaceReVerifiedAt: listing.safeSpaceReVerifiedAt ?? null,
    safeSpaceSub: listing.safeSpaceSub || null,
    safeSpacePromises: listing.safeSpacePromises,
    safeSpaceVouches: [...listing.safeSpaceVouches, ...memberVouches],
    safeSpaceRemoval: listing.safeSpaceRemoval,
    movedToListing:
      listing.operatingState === ListingOperatingState.Moved
        ? movedToListing
        : null,
    detailsConfirmedAt: listing.detailsConfirmedAt?.toISOString() ?? null,
  };
}

export function toListingDTO(
  listing: Listing,
  submittedBy: MemberRef | null,
  // Pre-loaded crop lookup for the four `photos` slots — the caller batches
  // ONE `MediaCropService.getMany` (see `listingPhotoKeys`) and passes the
  // resulting Map straight through; this mapper stays synchronous.
  crops: Map<string, CropRect> = new Map(),
): ListingDTO {
  const legacyPhotos = legacyPhotoSets(listing);
  return {
    ref: listing.ref,
    slug: listing.slug,
    status: listing.status,
    submittedBy,
    createdAt: listing.createdAt.toISOString(),

    path: listing.path,
    name: listing.name,
    cats: listing.cats,
    hood: listing.hood,
    badge: listing.badge,
    evidence: listing.evidence,
    price: listing.price,
    blurb: listing.blurb,
    tagline: listing.tagline,
    whatItIs: listing.whatItIs,
    tags: listing.tags,
    goodFor: listing.goodFor,
    accessibility: accessibilityView(listing),
    services: listing.services ?? [],
    langs: listing.langs,
    online: listing.online ?? false,
    address: listing.address,
    geocoded: listing.geocoded,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    hours: listing.hours,
    hoursNote: listing.hoursNote,
    hoursExceptions: listing.hoursExceptions ?? [],
    social: listing.social,
    photoGallery: toGalleryView(listing, crops),
    photos: legacyPhotoSetView(legacyPhotos.photos),
    photoCrops: toPhotoCrops(legacyPhotos.photos, crops),
    alt: legacyPhotos.alt,
    rel: listing.rel,
    ownerName: listing.ownerName,
    ownerRole: listing.ownerRole,
    ownerBio: listing.ownerBio,
    visibility: listing.visibility,
    linkToProfile: listing.linkToProfile,
    contactEmail: listing.contactEmail,
    consentOuting: listing.consentOuting,
    consentGuide: listing.consentGuide,
    // The badge as it currently reads: an expired grant stops saying
    // "verified" here too, so the owner and the moderation queue see exactly
    // what a member sees. The grant itself is preserved on the block below.
    queerOwnedVerified: isQueerOwnedCurrentlyVerified(listing),
    queerOwnedVerification: queerOwnedVerificationView(listing),
    affirmingBaseline: affirmingBaselineView(listing),
    operatingState: operatingStateView(listing),
    directoryVisibility: directoryVisibilityView(listing),
    movedToListingId:
      listing.operatingState === ListingOperatingState.Moved
        ? (listing.movedToListingId ?? null)
        : null,
    detailsConfirmedAt: listing.detailsConfirmedAt?.toISOString() ?? null,
  };
}

export type SafeSpaceCategory =
  'Bar' | 'Club' | 'Cafe' | 'Health' | 'Services' | 'Arts';

/** Map a listing's own category vocabulary to the coarse safe-space facet. */
export function mapSafeSpaceCategory(
  cats: string[],
  tags: string[],
): SafeSpaceCategory {
  const primary = (cats[0] ?? '').toLowerCase();
  const tagText = tags.join(' ').toLowerCase();
  if (primary === 'culture') return 'Arts';
  if (primary === 'health') return 'Health';
  if (primary === 'grooming') return 'Services';
  if (primary === 'food') {
    if (tagText.includes('club')) return 'Club';
    if (tagText.includes('bar')) return 'Bar';
    return 'Cafe';
  }
  if (tagText.includes('club')) return 'Club';
  if (tagText.includes('bar')) return 'Bar';
  if (tagText.includes('cafe') || tagText.includes('café')) return 'Cafe';
  if (tagText.includes('art')) return 'Arts';
  return 'Services';
}

export interface SafeSpaceCardDTO {
  status: 'verified';
  slug: string;
  cat: SafeSpaceCategory;
  typeLabel: string;
  name: string;
  hood: string;
  desc: string;
  tags: string[];
  rating: string;
  reviews: number;
  tier: number | null;
  /** The business's own trading state, so a safe-space card can badge a venue
   * that is shut this month. `permanently_closed` never reaches this list. */
  operatingState: OperatingStateView;
}

export interface RemovedSpaceCardDTO {
  status: 'removed';
  slug: string;
  cat: SafeSpaceCategory;
  typeLabel: string;
  name: string;
  hood: string;
  reason: string;
  removedDate: string;
  listedSince: string;
  flags: number;
}

export interface SafeSpaceVouchDTO {
  initials: string;
  name: string;
  tint: DirectoryTint;
  byline: string;
  text: string;
  when: string;
}

export interface SafeSpaceDetailDTO extends SafeSpaceCardDTO {
  eyebrow: string;
  sub: string;
  verifier: string;
  reVerified: string;
  metaPills: { label: string; accent?: boolean }[];
  promises: { title: string; desc: string }[];
  vouches: SafeSpaceVouchDTO[];
  glance: { label: string; value: string; accent?: boolean }[];
  address: string;
}

export interface RemovedSpaceDetailDTO extends RemovedSpaceCardDTO {
  reasonLong: string[];
  timeline: { date: string; event: string }[];
  whatNow: string;
}

export type AnySafeSpaceDetailDTO = SafeSpaceDetailDTO | RemovedSpaceDetailDTO;

export interface SafeSpaceListDTO {
  verified: SafeSpaceCardDTO[];
  removed: RemovedSpaceCardDTO[];
  stats: { verified: number; reviews: number; removed: number };
}

function safeSpaceTypeLabel(cat: SafeSpaceCategory): string {
  return cat === 'Health' ? 'Healthcare' : cat;
}

export function toSafeSpaceCard(
  listing: Listing,
  reviews: ListingReview[],
): SafeSpaceCardDTO {
  const cat = mapSafeSpaceCategory(listing.cats, listing.tags);
  const rating = ratingFromReviews(reviews);
  return {
    status: 'verified',
    slug: listing.slug,
    cat,
    typeLabel: safeSpaceTypeLabel(cat),
    name: listing.name,
    hood: listing.hood,
    desc: listing.blurb,
    tags: listing.tags,
    rating: rating.score,
    reviews: rating.count,
    tier: listing.safeSpaceTier,
    operatingState: operatingStateView(listing),
  };
}

export function toRemovedSpaceCard(listing: Listing): RemovedSpaceCardDTO {
  const cat = mapSafeSpaceCategory(listing.cats, listing.tags);
  const removal = listing.safeSpaceRemoval;
  return {
    status: 'removed',
    slug: listing.slug,
    cat,
    typeLabel: safeSpaceTypeLabel(cat),
    name: listing.name,
    hood: listing.hood,
    reason: removal?.reason ?? '',
    removedDate: removal?.removedDate ?? '',
    listedSince: removal?.listedSince ?? '',
    flags: removal?.flags ?? 0,
  };
}

export function toSafeSpaceDetail(
  listing: Listing,
  reviews: ListingReview[],
  /** Normalized member-written vouches (raw `SafeSpaceVouch` shape), merged
   * AFTER the curated jsonb vouches so both surface on the hub detail page. */
  memberVouches: SafeSpaceVouch[] = [],
): SafeSpaceDetailDTO {
  const card = toSafeSpaceCard(listing, reviews);
  const glance: { label: string; value: string; accent?: boolean }[] = [
    { label: 'Type', value: card.typeLabel },
    { label: 'Neighbourhood', value: listing.hood, accent: true },
    { label: 'Languages', value: listing.langs.join(' · ') },
  ];
  if (listing.safeSpaceReVerifiedAt) {
    glance.push({
      label: 'Last verified',
      value: listing.safeSpaceReVerifiedAt,
    });
  }
  return {
    ...card,
    eyebrow: `${card.typeLabel} · ${listing.hood} · ${listing.city || 'Lisbon'}`,
    sub: listing.safeSpaceSub || listing.blurb,
    verifier: listing.safeSpaceVerifier,
    reVerified: listing.safeSpaceReVerifiedAt ?? '',
    metaPills: listing.tags.map((label, index) => ({
      label,
      accent: index % 2 === 1,
    })),
    promises: listing.safeSpacePromises,
    vouches: [...listing.safeSpaceVouches, ...memberVouches].map((vouch) => ({
      initials: initialsForName(vouch.name),
      name: vouch.name,
      tint: tintForSlug(vouch.name),
      byline: vouch.byline,
      text: vouch.text,
      when: vouch.when,
    })),
    glance,
    address: listing.address,
  };
}

export function toRemovedSpaceDetail(listing: Listing): RemovedSpaceDetailDTO {
  const removal = listing.safeSpaceRemoval;
  return {
    ...toRemovedSpaceCard(listing),
    reasonLong: removal?.reasonLong ?? [],
    timeline: removal?.timeline ?? [],
    whatNow: removal?.whatNow ?? '',
  };
}

/**
 * Admin queue row for a member-submitted "suggest an edit" correction
 * (`GET /admin/listings/edit-suggestions`). Carries the target listing's
 * `ref`/`name` (not just its id) so the moderation UI can render/link the
 * row without a second lookup, mirroring `ListingDTO.submittedBy`'s
 * denormalized-for-display convention.
 */
export interface EditSuggestionDTO {
  id: string;
  listingRef: string;
  listingName: string;
  field: string;
  message: string;
  status: ListingEditSuggestionStatus;
  submittedBy: MemberRef | null;
  createdAt: string;
}

export function toEditSuggestionDTO(
  suggestion: ListingEditSuggestion,
  listing: Listing,
  submittedBy: MemberRef | null,
): EditSuggestionDTO {
  return {
    id: suggestion.id,
    listingRef: listing.ref,
    listingName: listing.name,
    field: suggestion.field,
    message: suggestion.message,
    status: suggestion.status,
    submittedBy,
    createdAt: suggestion.createdAt.toISOString(),
  };
}
