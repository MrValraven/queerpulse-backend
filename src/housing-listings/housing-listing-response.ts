import { toImageUrl } from '../common/image-url';
import { MemberRef } from '../common/member-ref';
import { VerificationLevel } from '../verification/verification-level';
import { HOUSING_TIMEZONE } from './housing-city';
import { HousingListerRef } from './housing-lister-lookup';
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
 * The last moderation decision recorded on a listing. Owner- and
 * moderator-visible only (see `HousingListingDTO.decision`).
 */
export interface HousingListingDecisionSummaryDTO {
  /** The status the moderator moved the listing INTO. */
  status: HousingListingStatus;
  /** The moderator's reason. Required for every decision except an approval,
   * where it is an optional note, so this is null only on a bare approval. */
  reason: string | null;
  /** ISO-8601 timestamp of the decision. */
  at: string;
}

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
  lister: HousingListerRef | null;
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
  /**
   * The moderator's last decision on this listing, attached ONLY for the owner
   * and for moderators (`includeDecision`). `reason` is moderator-authored
   * prose and never reaches public browse. `null` while no decision has been
   * recorded yet, and `null` for every viewer who is not entitled to it, so a
   * client cannot tell the two apart from a public read.
   */
  decision: HousingListingDecisionSummaryDTO | null;
  /** Owner "found a place / no longer looking" signal (HSG-1), or null while
   * still looking. Set by the owner (`mark-filled`/`mark-available`) or by the
   * daily expiry sweep — either way, a filled listing is withheld from public
   * browse but still visible to its owner on `GET /housing-listings/mine`. */
  filledAt: string | null;
  /** TTL (HSG-3) — auto-computed at create time, resettable via `extend`. */
  expiresAt: string;
  /** Server-computed `expiresAt < now` — avoids client clock skew. A listing
   * can be expired before the daily sweep has actually run; browse already
   * excludes it either way (see `HousingDirectoryService.browse`). */
  expired: boolean;

  type: HousingListingType;
  title: string;
  blurb: string;
  city: string;
  /**
   * IANA timezone every date on this listing is expressed in. A constant
   * (`Europe/Lisbon`) served explicitly so no client has to hardcode a
   * fallback, and so the day a second city becomes real the wire already
   * carries the answer.
   */
  timezone: string;
  area: string;
  rentEuros: number;
  /** Bedroom count (0 = studio), or null when the lister didn't set it. */
  bedrooms: number | null;
  billsIncluded: boolean;
  /**
   * Always `true` (BE-HSG-07). Posting a home requires the mandatory LGBTQ+
   * affirming pledge, so this is a constant, not a distinguishing attribute of
   * one listing versus another. Kept on the wire so existing clients do not
   * break; it must NOT be rendered as a per-listing chip or offered as a browse
   * filter, because both restate affirmation as optional.
   */
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
 * @param includeDecision When true, the moderator's last decision (including
 *   their free-text reason) is attached. Deliberately SEPARATE from `precise`:
 *   `precise` is also granted to a connected member and to an enquirer with an
 *   accepted viewing, and neither of them may read a moderator's note about
 *   somebody else's listing. Only the owner's own management reads
 *   (`listMine`/`getByRef`/`create`) and the moderator console set it.
 */
export function toHousingListingDTO(
  listing: HousingListing,
  lister: HousingListerRef | null,
  listerVerificationLevel: VerificationLevel,
  precise = false,
  includeDecision = false,
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
    decision:
      includeDecision && listing.decidedAt
        ? {
            status: listing.status,
            reason: listing.decisionReason,
            at: listing.decidedAt.toISOString(),
          }
        : null,
    filledAt: listing.filledAt ? listing.filledAt.toISOString() : null,
    expiresAt: listing.expiresAt.toISOString(),
    expired: listing.expiresAt.getTime() < Date.now(),

    type: listing.type,
    title: listing.title,
    blurb: listing.blurb,
    city: listing.city,
    timezone: HOUSING_TIMEZONE,
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
 * What a moderator has decided about THIS LISTER before, aggregated over their
 * own housing listings.
 *
 * The review console's job is to decide about a stranger in a few seconds, and
 * the single most useful thing it can say is "you have refused this person
 * twice already" or "this is their fourth live listing". Without it a moderator
 * has to open a second surface per row, which in practice means nobody checks.
 *
 * Counts only. No listing titles, no other listing's address, no other
 * lister: this is the standing of the one member whose listing is on screen.
 */
export interface HousingListerHistoryDTO {
  /** Every housing listing this member has ever posted, this one included. */
  totalListings: number;
  /** How many of them are live right now. */
  liveListings: number;
  /** How many a moderator sent back for changes. */
  changesRequestedListings: number;
  /** How many a moderator refused outright. */
  rejectedListings: number;
  /** How many a moderator pulled after they were published. */
  takenDownListings: number;
  /** True when this member has never had a listing refused or pulled. */
  hasCleanRecord: boolean;
}

/**
 * Moderator/admin wire shape — the full public DTO PLUS everything a human
 * needs to decide without opening five tabs: the pre-publish risk signals
 * (P0.6), the lister's standing, and the last decision already recorded.
 *
 * `riskScore`/`riskReasons` are deliberately absent from `HousingListingDTO` so
 * they can never leak onto public browse; only the moderator-gated admin routes
 * return them, to power the risk-sorted queue with the reasons visible.
 *
 * ADDRESS PRIVACY: this DTO maps with `precise: true`, so it carries the exact
 * point and the full street address. That is correct for a moderator (they are
 * reviewing a real home) and is why this shape must never be returned from any
 * route outside `AdminHousingListingsController`.
 */
export interface AdminHousingListingDTO extends HousingListingDTO {
  riskScore: number;
  /** Stable machine codes from `housing-risk.ts` (`rent_far_below_market`,
   * `contact_info_in_text`, `discriminatory_language`, …), in a fixed order.
   * Localized by the console, never here. */
  riskReasons: string[];
  /** The lister's own prior record. Null when the lister erased their account,
   * because there is no member left to have a record. */
  listerHistory: HousingListerHistoryDTO | null;
  /** Who recorded `decision`, when one is present. Null for an unreviewed
   * listing, and null once that moderator erased their account. */
  decidedBy: MemberRef | null;
}

export function toAdminHousingListingDTO(
  listing: HousingListing,
  lister: HousingListerRef | null,
  listerVerificationLevel: VerificationLevel,
  listerHistory: HousingListerHistoryDTO | null = null,
  decidedBy: MemberRef | null = null,
): AdminHousingListingDTO {
  // Moderators see the exact location too (precise: true), same as the owner,
  // and are the other party entitled to the decision trail (includeDecision).
  return {
    ...toHousingListingDTO(
      listing,
      lister,
      listerVerificationLevel,
      true,
      true,
    ),
    riskScore: listing.riskScore,
    riskReasons: listing.riskReasons,
    listerHistory,
    decidedBy,
  };
}
