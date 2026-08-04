import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import {
  ListingEditSuggestion,
  ListingEditSuggestionStatus,
} from './entities/listing-edit-suggestion.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingDayHours,
  ListingPhotoSet,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
  SafeSpacePromise,
  SafeSpaceRemoval,
  SafeSpaceVouch,
} from './entities/listing.entity';

/**
 * Response-side shape of `photos` — `normalizePhotoSet` (listings.service.ts)
 * defaults missing slots to `''`, and `toImageUrl('')` returns `null`, so the
 * response widens each field to `string | null`. The entity's own
 * `ListingPhotoSet` (still `string` fields, storage keys/external URLs as
 * persisted) is unchanged.
 */
export interface ListingPhotoSetView {
  wide: string | null;
  d1: string | null;
  d2: string | null;
  vibe: string | null;
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
  verify: string;
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
  goodFor: string[];
  langs: string[];
  address: string;
  geocoded: boolean;
  latitude: number | null;
  longitude: number | null;
  hours: Record<string, ListingDayHours>;
  hoursNote: string;
  social: ListingSocial;
  photos: ListingPhotoSetView;
  alt: ListingPhotoSet;
  rel: string;
  ownerName: string;
  ownerRole: string;
  ownerBio: string;
  visibility: string;
  linkToProfile: boolean;
  contactEmail: string;
  notify: string[];
  consentOuting: boolean;
  consentGuide: boolean;
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
  slug: string;
  name: string;
  cat: string;
  hood: string;
  blurb: string;
  tint: DirectoryTint;
  av: string;
  owned: boolean;
  memberFirst: string | null;
  // Map pin, when the owner placed one while listing. null ⇒ list-only (no pin).
  latitude: number | null;
  longitude: number | null;
  // Safe-space badge primitives for the card. Deliberately lean — detail-only
  // fields (promises/vouches/removal/verifier/re-verified-at) are NOT surfaced
  // here; see `SafeSpaceDetailDTO`/`RemovedSpaceDetailDTO` for those.
  safeSpaceStatus: 'none' | 'verified' | 'removed';
  safeSpaceTier: number | null;
}

export function toDirectoryCard(listing: Listing): DirectoryCardDTO {
  const owner = ownerIdentity(listing);
  return {
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
    // The "run by <first>" line names the owner, so it follows their chosen
    // visibility — null for `anon`/`role` (where `owner.first` is blank).
    memberFirst: listing.linkToProfile ? owner.first || null : null,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    safeSpaceStatus: listing.safeSpaceStatus,
    safeSpaceTier: listing.safeSpaceTier ?? null,
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
  /** The review's uuid PK — targets `PATCH :ref/reviews/:reviewId/reply`. */
  id: string;
  initials: string;
  name: string;
  tint: DirectoryTint;
  byline: string;
  stars: number;
  text: string;
  helpful: number;
  ownerReply: ReviewOwnerReplyDTO | null;
  /** Reviewer's profile photo, when they are a member with one. `null` → the
   * frontend falls back to the tinted `initials` avatar. */
  avatarUrl: string | null;
  /** Reviewer's profile slug, when they are a member. `null` → the frontend
   * renders the name as plain text (seeded/non-member review); when set it
   * links to `/members/:authorSlug`. */
  authorSlug: string | null;
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
    helpful: review.helpful,
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
  gallery: string[];
  /** Real uploaded images (storage-resolved URLs), paired with `alt`. `null`
   * per empty slot. The FE renders these as a gallery; `gallery` (alt-text
   * captions) remains the fallback for listings/demo places without photos. */
  photos: ListingPhotoSetView;
  alt: ListingPhotoSet;
  /** Real per-weekday opening hours, keyed by the FE `DAYS` id (`Mon`..`Sun`).
   * The FE computes an open/closed status from this; empty → status unknown. */
  hours: Record<string, ListingDayHours>;
  langs: string[];
  whatItIs: string[];
  goodFor: DirectoryGoodFor[];
  hoursType: DirectoryHoursType;
  hoursNote: string;
  owner: DirectoryOwner;
  social: ListingSocial;
  address: string;
  rating: { score: string; count: number };
  reviews: ReviewDTO[];
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
): DirectoryDetailDTO {
  const tint = tintForSlug(listing.slug);
  return {
    ...toDirectoryCard(listing),
    ref: listing.ref,
    tagline: listing.tagline,
    // Empty text columns read as "unset" (frontend then defaults to Lisbon /
    // Europe-Lisbon), same `|| null` idiom the safe-space fields below use.
    city: listing.city || null,
    timezone: listing.timezone || null,
    // Price tier first (when set), then the listing's own tags, as detail pills.
    pills: [...(listing.price ? [listing.price] : []), ...listing.tags],
    // The gallery renders caption cells (no images in the prototype), so we
    // surface the alt-text captions, dropping empty slots.
    gallery: [
      listing.alt.wide,
      listing.alt.d1,
      listing.alt.d2,
      listing.alt.vibe,
    ].filter((caption) => caption.length > 0),
    photos: {
      wide: toImageUrl(listing.photos.wide),
      d1: toImageUrl(listing.photos.d1),
      d2: toImageUrl(listing.photos.d2),
      vibe: toImageUrl(listing.photos.vibe),
    },
    alt: listing.alt,
    hours: listing.hours,
    langs: listing.langs,
    whatItIs: listing.whatItIs.map((line) => line.text),
    // The listing stores positive bullets only, so every one is a "yes".
    goodFor: listing.goodFor.map((label) => ({ label, yes: true })),
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
    upcoming: upcomingEvents.map(toUpcomingEvent),
    savedCount,
    // Empty-string defaults (never-a-safe-space listings) read as "no value"
    // here, same as `safeSpaceTier` already does on the inherited card DTO.
    safeSpaceVerifier: listing.safeSpaceVerifier || null,
    safeSpaceReVerifiedAt: listing.safeSpaceReVerifiedAt ?? null,
    safeSpaceSub: listing.safeSpaceSub || null,
    safeSpacePromises: listing.safeSpacePromises,
    safeSpaceVouches: listing.safeSpaceVouches,
    safeSpaceRemoval: listing.safeSpaceRemoval,
  };
}

export function toListingDTO(
  listing: Listing,
  submittedBy: MemberRef | null,
): ListingDTO {
  return {
    ref: listing.ref,
    slug: listing.slug,
    status: listing.status,
    submittedBy,
    createdAt: listing.createdAt.toISOString(),

    path: listing.path,
    verify: listing.verify,
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
    langs: listing.langs,
    address: listing.address,
    geocoded: listing.geocoded,
    latitude: listing.latitude ?? null,
    longitude: listing.longitude ?? null,
    hours: listing.hours,
    hoursNote: listing.hoursNote,
    social: listing.social,
    photos: {
      wide: toImageUrl(listing.photos.wide),
      d1: toImageUrl(listing.photos.d1),
      d2: toImageUrl(listing.photos.d2),
      vibe: toImageUrl(listing.photos.vibe),
    },
    alt: listing.alt,
    rel: listing.rel,
    ownerName: listing.ownerName,
    ownerRole: listing.ownerRole,
    ownerBio: listing.ownerBio,
    visibility: listing.visibility,
    linkToProfile: listing.linkToProfile,
    contactEmail: listing.contactEmail,
    notify: listing.notify,
    consentOuting: listing.consentOuting,
    consentGuide: listing.consentGuide,
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
    vouches: listing.safeSpaceVouches.map((vouch) => ({
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
 * (`GET /listings/admin/edit-suggestions`). Carries the target listing's
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
