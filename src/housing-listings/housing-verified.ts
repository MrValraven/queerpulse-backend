import { VerificationLevel } from '../verification/verification-level';
import {
  HousingListing,
  HousingListingStatus,
} from './entities/housing-listing.entity';

/**
 * The "verified listing" chip (P2.3) is derived SERVER-SIDE from real signals —
 * a lister can never self-assert it. The Roomster/FTC lesson: a verification
 * badge that does not point at a genuine event is a lie that helps scammers, so
 * this state is granted only when all three of the following hold at once:
 *
 *  1. the lister is `id_verified` — a recorded government-ID check event (not
 *     email or phone, and never a self-set flag);
 *  2. the listing passed human moderation to `live` (a stranger's submission
 *     that is still in `review`/`question` is never "verified"); and
 *  3. the listing's deterministic pre-publish risk score is BELOW
 *     `VERIFIED_LISTING_MAX_RISK` — i.e. it carries essentially no red flags.
 *
 * Anything short of all three leaves the listing unverified, with a stable
 * reason code naming the FIRST failing gate so the honesty of the chip is
 * auditable. Only the boolean + reason ever reach the public DTO; the raw risk
 * score stays admin-only.
 */

/**
 * A listing at or above this pre-publish risk score can never be "verified",
 * even with an ID-verified lister on a live listing. Deliberately far stricter
 * than `HIGH_RISK_THRESHOLD` (50, the "must stay in human review" line): the
 * verified chip is a positive trust claim, so it demands a near-clean listing,
 * not merely a not-blocked one.
 */
export const VERIFIED_LISTING_MAX_RISK = 20;

export type ListingVerifiedReason =
  | 'id_verified_live_low_risk'
  | 'lister_not_id_verified'
  | 'listing_not_live'
  | 'risk_above_threshold';

export interface ListingVerifiedResult {
  verified: boolean;
  /** Stable machine code — the granting condition when `verified`, else the
   * first failing gate. Localized by the frontend, never here. */
  reason: ListingVerifiedReason;
}

export function deriveListingVerified(
  listing: Pick<HousingListing, 'status' | 'riskScore'>,
  listerVerificationLevel: VerificationLevel,
): ListingVerifiedResult {
  if (listerVerificationLevel !== VerificationLevel.IdVerified) {
    return { verified: false, reason: 'lister_not_id_verified' };
  }
  if (listing.status !== HousingListingStatus.Live) {
    return { verified: false, reason: 'listing_not_live' };
  }
  if (listing.riskScore >= VERIFIED_LISTING_MAX_RISK) {
    return { verified: false, reason: 'risk_above_threshold' };
  }
  return { verified: true, reason: 'id_verified_live_low_risk' };
}
