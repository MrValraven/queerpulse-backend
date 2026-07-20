import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
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
