import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { Event } from '../events/entities/event.entity';
import { ListingReview } from './entities/listing-review.entity';
import {
  Listing,
  ListingDayHours,
  ListingPhotoSet,
  ListingSocial,
  ListingStatus,
  ListingWitLine,
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
  return DIRECTORY_TINTS[hash];
}

/** Two-letter avatar initials from the business name (e.g. "Galeria Lume" → "GL"). */
function initialsForName(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return '';
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
  return (words[0][0] + words[1][0]).toUpperCase();
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
}

export function toDirectoryCard(listing: Listing): DirectoryCardDTO {
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
    memberFirst: listing.linkToProfile
      ? ownerFirstName(listing.ownerName) || null
      : null,
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
}

/**
 * An upcoming event at a listing's venue. `startAt` is an ISO timestamp — the
 * frontend composes the localized "Sat 21 Jun · 20:00" line (presentation
 * split), so the server never bakes in an English date string.
 */
export interface UpcomingEventDTO {
  startAt: string;
  title: string;
}

export function toUpcomingEvent(event: Event): UpcomingEventDTO {
  return { startAt: event.startAt.toISOString(), title: event.title };
}

/** One review row on the detail page. `initials`/`tint` are server-derived. */
export interface ReviewDTO {
  initials: string;
  name: string;
  tint: DirectoryTint;
  byline: string;
  stars: number;
  text: string;
  helpful: number;
}

export function toReviewDTO(review: ListingReview): ReviewDTO {
  return {
    initials: initialsForName(review.reviewerName),
    name: review.reviewerName,
    tint: tintForSlug(review.reviewerName),
    byline: review.byline,
    stars: review.stars,
    text: review.text,
    helpful: review.helpful,
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
  tagline: string;
  pills: string[];
  gallery: string[];
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
}

export function toDirectoryDetail(
  listing: Listing,
  reviews: ListingReview[],
  upcomingEvents: Event[],
): DirectoryDetailDTO {
  const tint = tintForSlug(listing.slug);
  return {
    ...toDirectoryCard(listing),
    tagline: listing.tagline,
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
    whatItIs: listing.whatItIs.map((line) => line.text),
    // The listing stores positive bullets only, so every one is a "yes".
    goodFor: listing.goodFor.map((label) => ({ label, yes: true })),
    hoursType: hoursTypeForCategory(listing.cats[0] ?? ''),
    hoursNote: listing.hoursNote,
    owner: {
      name: listing.ownerName,
      initials: initialsForName(listing.ownerName),
      tint,
      role: listing.ownerRole,
      bio: listing.ownerBio,
      inQueerPulse: listing.linkToProfile,
      first: ownerFirstName(listing.ownerName),
    },
    social: listing.social,
    address: listing.address,
    rating: ratingFromReviews(reviews),
    reviews: reviews.map(toReviewDTO),
    upcoming: upcomingEvents.map(toUpcomingEvent),
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
    eyebrow: `${card.typeLabel} · ${listing.hood} · Lisbon`,
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
