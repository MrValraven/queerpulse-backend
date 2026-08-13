import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { VerificationLevel } from '../verification/verification-level';
import {
  HousingListerKind,
  HousingListing,
  HousingListingStatus,
  HousingListingType,
} from './entities/housing-listing.entity';
import { resolveAreaCentroid } from './housing-geo';
import {
  deriveListingVerified,
  ListingVerifiedReason,
} from './housing-verified';

/**
 * Wire shape for a housing listing. Used for both the owner view and the
 * public browse — it exposes no contact/moderation-sensitive columns beyond
 * `status`, and `lister` is the same compact `MemberRef` every other domain
 * embeds. `gallery` is resolved to displayable URLs (empty slots dropped).
 */
export interface HousingListingDTO {
  ref: string;
  slug: string;
  status: HousingListingStatus;
  lister: MemberRef | null;
  /** The lister's REAL identity-verification level — powers an honest badge on
   * the listing. Never a decorative flag; it reflects a recorded verification
   * event (or the `email` floor when none higher exists). */
  listerVerificationLevel: VerificationLevel;
  /** Whether this listing has earned the honest "verified listing" chip (P2.3).
   * Derived server-side from real signals — id-verified lister AND live AND
   * low risk — never a self-set flag. See `housing-verified.ts`. */
  listingVerified: boolean;
  /** The stable machine code behind `listingVerified` — the granting condition
   * when true, or the first failing gate when false. Powers an honest tooltip
   * that states exactly what the chip means (or why it's absent). */
  listingVerifiedReason: ListingVerifiedReason;
  createdAt: string;

  type: HousingListingType;
  title: string;
  blurb: string;
  city: string;
  area: string;
  rentEuros: number;
  /** Bedroom count (0 = studio), or null when the lister didn't set it. */
  bedrooms: number | null;
  billsIncluded: boolean;
  lgbtqFriendly: boolean;
  // Transparency (P2.6) — public-safe: every listing discloses its access line
  // and whether it's listed by a member or an agent/broker.
  accessibilityInfo: string;
  listerKind: HousingListerKind;
  availableFrom: string | null;
  minStayMonths: number | null;
  description: string;
  features: string[];
  idealFor: string[];
  gallery: string[];
  /** Optional 360°/virtual-tour link (https), or null when none was added. */
  virtualTourUrl: string | null;

  // ── Location (ADDRESS PRIVACY) ─────────────────────────────────────────────
  // `approx*` is the neighbourhood-centroid pin — always safe to show, derived
  // from `area`/`city`, never the real point. `precise*` + `addressLine` are the
  // exact home, attached ONLY when the viewer is the owner or an accepted
  // (mutually-connected) enquirer AND the listing has stored coordinates.
  // `locationPrecision` tells the client which pin it holds: `'area'` → show the
  // "approximate — exact address shared after you connect" note; `'exact'` → the
  // precise pin + address are present.
  approxLatitude: number | null;
  approxLongitude: number | null;
  preciseLatitude: number | null;
  preciseLongitude: number | null;
  addressLine: string | null;
  locationPrecision: 'area' | 'exact';
}

/**
 * Lightweight row for the cross-entity global search (`SearchService`) — no
 * lister/gallery hydration, just what the search-result card renders. Mapped
 * to a `SearchResultDTO` by hand in `search/search-response.ts`.
 */
export interface HousingSearchRow {
  slug: string;
  title: string;
  city: string;
  area: string;
}

export function toHousingSearchRow(listing: HousingListing): HousingSearchRow {
  return {
    slug: listing.slug,
    title: listing.title,
    city: listing.city,
    area: listing.area,
  };
}

/**
 * @param precise When true, the viewer is the owner or an accepted enquirer, so
 *   the exact point + full address may be attached. Defaults to false — every
 *   public/pre-connection read gets the approximate neighbourhood pin only.
 */
export function toHousingListingDTO(
  listing: HousingListing,
  lister: MemberRef | null,
  listerVerificationLevel: VerificationLevel,
  precise = false,
): HousingListingDTO {
  // The approximate pin is ALWAYS the area centroid, never the stored precise
  // point — so a public read can never be reverse-engineered into the address.
  const centroid = resolveAreaCentroid(listing.city, listing.area);
  const hasExact =
    precise && listing.latitude !== null && listing.longitude !== null;
  const verified = deriveListingVerified(listing, listerVerificationLevel);
  return {
    ref: listing.ref,
    slug: listing.slug,
    status: listing.status,
    lister,
    listerVerificationLevel,
    listingVerified: verified.verified,
    listingVerifiedReason: verified.reason,
    createdAt: listing.createdAt.toISOString(),

    type: listing.type,
    title: listing.title,
    blurb: listing.blurb,
    city: listing.city,
    area: listing.area,
    rentEuros: listing.rentEuros,
    bedrooms: listing.bedrooms,
    billsIncluded: listing.billsIncluded,
    lgbtqFriendly: listing.lgbtqFriendly,
    accessibilityInfo: listing.accessibilityInfo,
    listerKind: listing.listerKind,
    availableFrom: listing.availableFrom,
    minStayMonths: listing.minStayMonths,
    description: listing.description,
    features: listing.features,
    idealFor: listing.idealFor,
    // toImageUrl('') -> null; drop empty/unset slots so the client renders a
    // clean gallery.
    gallery: listing.gallery
      .map((ref) => toImageUrl(ref))
      .filter((url): url is string => url !== null),
    virtualTourUrl: listing.virtualTourUrl,

    approxLatitude: centroid?.latitude ?? null,
    approxLongitude: centroid?.longitude ?? null,
    preciseLatitude: hasExact ? listing.latitude : null,
    preciseLongitude: hasExact ? listing.longitude : null,
    addressLine: precise ? listing.addressLine : null,
    locationPrecision: hasExact ? 'exact' : 'area',
  };
}

/**
 * Moderator/admin wire shape — the full public DTO PLUS the pre-publish risk
 * signals (P0.6). `riskScore`/`riskReasons` are deliberately absent from
 * `HousingListingDTO` so they can never leak onto public browse; only the
 * `@Roles(Moderator, Admin)` admin list returns them, to power the risk-sorted
 * queue with the reasons visible.
 */
export interface AdminHousingListingDTO extends HousingListingDTO {
  riskScore: number;
  riskReasons: string[];
}

export function toAdminHousingListingDTO(
  listing: HousingListing,
  lister: MemberRef | null,
  listerVerificationLevel: VerificationLevel,
): AdminHousingListingDTO {
  // Moderators see the exact location too (precise: true), same as the owner.
  return {
    ...toHousingListingDTO(listing, lister, listerVerificationLevel, true),
    riskScore: listing.riskScore,
    riskReasons: listing.riskReasons,
  };
}
