import {
  VerificationLevel,
  levelRank,
} from '../verification/verification-level';
import { HousingListingType } from './entities/housing-listing.entity';

/**
 * Deterministic pre-publish risk assessment for a member-submitted housing
 * listing (Wave B1 "listing integrity" P0.6). Given the fields a lister
 * submits plus their real verification level, it produces a 0–100 `score` and a
 * stable list of machine `reasons`. NOTHING here is random — the same input
 * always yields the same score — so a moderator can trust the queue order and a
 * spec can pin exact numbers.
 *
 * The score does NOT auto-publish anything: every new listing still lands in
 * `review` (see `HousingListingsService.create`). What it does is (a) sort the
 * moderation queue so the riskiest listings surface first, and (b) act as the
 * guard that keeps a high-risk listing out of `live` if a future auto-approve
 * rule is ever added — a listing at or above `HIGH_RISK_THRESHOLD` must always
 * pass a human first.
 */
export interface HousingRiskInput {
  type: HousingListingType;
  title: string;
  blurb: string;
  description: string;
  rentEuros: number;
  accessibilityInfo: string;
  gallery: string[];
  features: string[];
  listerVerificationLevel: VerificationLevel;
}

export interface HousingRiskAssessment {
  /** 0 (clean) … 100 (many strong red flags), clamped. */
  score: number;
  /** Stable machine codes, in a fixed order — never localized here. */
  reasons: string[];
}

/**
 * At or above this, a listing must stay in the human `review` queue and can
 * never be auto-published. 50 = roughly "two moderate flags, or one strong one
 * plus an unverified lister".
 */
export const HIGH_RISK_THRESHOLD = 50;

/**
 * Lisbon monthly-rent sanity floors per listing type (EUR). A rent BELOW
 * `floor` is cheaper than the bottom of a plausible range (a classic
 * advance-fee-scam hook); a rent below `farBelow` is implausibly low. Derived
 * from the brief's ranges (room €450–600, "double" €350–450, studio/whole-flat
 * €700–1000). `short` is priced per NIGHT, not per month, so a monthly floor
 * would misfire — it is deliberately excluded from the rent check.
 */
const RENT_FLOORS: Partial<
  Record<HousingListingType, { floor: number; farBelow: number }>
> = {
  [HousingListingType.Room]: { floor: 450, farBelow: 300 },
  [HousingListingType.Studio]: { floor: 700, farBelow: 450 },
  [HousingListingType.Sublet]: { floor: 700, farBelow: 450 },
};

// Contact details a listing should never carry — the enquiry belongs on
// QueerPulse, where moderators and safety tooling can see it. PT + EN.
const EMAIL_RE = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
// PT mobile/landline or an international number, allowing spaces/dots/dashes.
const PHONE_RE = /(?:\+?351[\s.-]?)?(?:9\d{2}|2\d{2})[\s.-]?\d{3}[\s.-]?\d{3}/;
const IBAN_RE = /\biban\b|\bpt50\b|\bpt\d{2}\s?\d{4}\b/i;
const MESSENGER_RE = /\bwhats\s?app\b|\bwa\.me\b|\btelegram\b|\bsignal\b/i;

// Off-platform / advance-payment language — the actual scam ask, in PT + EN.
const OFF_PLATFORM_RE =
  /\bmb\s?way\b|\bmbway\b|\bmultibanco\b|\bwire\s?transfer\b|\bwestern\s?union\b|\bpay(?:ment)?\s+(?:before|in advance|upfront|first)\b|\bdeposit\s+before\b|\btransfer\s+before\b|\bpagar\s+antes\b|\bsinal\s+antes\b|\bdep[óo]sito\s+antes\b|\btransfer[êe]ncia\s+antes\b|\bpagamento\s+adiantado\b/i;

// Discriminatory red-flag phrasing (PT + EN). Curated dog-whistles that gate a
// home on identity/beliefs rather than describe the space.
const DISCRIMINATORY_RE =
  /\btraditional\s+family\b|\bfamily\s+values\b|\bcertain\s+values\b|\bright\s+values\b|\bsame\s+religion\b|\bchristian(?:s)?\s+only\b|\bno\s+couples\b|\bstraight\s+only\b|\bno\s+lgbt\b|\bfam[íi]lia\s+tradicional\b|\bvalores\s+tradicionais\b|\bcertos\s+valores\b|\bmesma\s+religi[ãa]o\b|\bsem\s+casais\b/i;

/**
 * Score a listing's red-flag signals. Weights are additive and the total is
 * clamped to 100; the maximum unclamped sum (~140) means several strong flags
 * saturate the score, which is intended.
 */
export function assessHousingRisk(
  input: HousingRiskInput,
): HousingRiskAssessment {
  const reasons: string[] = [];
  let score = 0;

  // ── Signal 1: implausibly low rent (advance-fee hook) ──────────────────────
  const rentBand = RENT_FLOORS[input.type];
  if (rentBand && input.rentEuros > 0) {
    if (input.rentEuros < rentBand.farBelow) {
      score += 30;
      reasons.push('rent_far_below_market');
    } else if (input.rentEuros < rentBand.floor) {
      score += 15;
      reasons.push('rent_below_market');
    }
  }

  // ── Signal 2 & 3: contact info / off-platform payment language ──────────────
  const text =
    `${input.title} ${input.blurb} ${input.description}`.toLowerCase();
  if (
    EMAIL_RE.test(text) ||
    PHONE_RE.test(text) ||
    IBAN_RE.test(text) ||
    MESSENGER_RE.test(text)
  ) {
    score += 25;
    reasons.push('contact_info_in_text');
  }
  if (OFF_PLATFORM_RE.test(text)) {
    score += 25;
    reasons.push('off_platform_payment_language');
  }

  // ── Signal 4: discriminatory red-flag phrasing ─────────────────────────────
  if (DISCRIMINATORY_RE.test(text)) {
    score += 25;
    reasons.push('discriminatory_language');
  }

  // ── Signal 5: lister assurance (lower verification = higher risk) ──────────
  const rank = levelRank(input.listerVerificationLevel);
  if (rank <= levelRank(VerificationLevel.Email)) {
    score += 15;
    reasons.push('lister_unverified');
  } else if (rank === levelRank(VerificationLevel.Phone)) {
    score += 5;
    reasons.push('lister_phone_only');
  }

  // ── Signal 6: incompleteness (thin listings are harder to trust) ───────────
  if (input.description.trim().length < 40) {
    score += 10;
    reasons.push('incomplete_listing');
  }
  if (input.gallery.length === 0) {
    score += 5;
    reasons.push('no_photos');
  }
  if (input.accessibilityInfo.trim().length === 0) {
    score += 5;
    reasons.push('missing_accessibility_info');
  }

  return { score: Math.min(score, 100), reasons };
}
