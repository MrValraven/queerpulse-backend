/**
 * The raw eligibility signal set for the signed-in member: counts and
 * timestamps, with no policy applied. The evaluator in
 * `public-eligibility.rules.ts` turns these into a decision.
 *
 * Hand-mapped per repo convention (no global serializer).
 */
export interface PublicEligibilitySignals {
  verified: boolean;
  tenureDays: number;
  /** ISO timestamps of published pieces, most-recent first, capped at 50. */
  publishedPieces: string[];
  /** ISO start times of hosted open+published events, most-recent first, capped at 50. */
  hostedOpenEvents: string[];
  publishedSubprofiles: number;
  vouchCount: number;
  /** How many members this member has vouched FOR (not withdrawn) — the
   *  outbound side of the trust graph, distinct from `vouchCount` (inbound).
   *  Signup's auto-vouch runs the invitER as voucher, so this only counts a
   *  vouch the member gave of their own accord. */
  vouchesGivenCount: number;
  endorsementCount: number;
  connectionCount: number;
  eventsAttended: number;
  communityPosts: number;
  /** Always 0: the requester is active now (see design — no lastSeenAt column). */
  lastActiveDaysAgo: number;
  standingOk: boolean;
}

/** The three capped scoring families. */
export type PublicEligibilityFamilyKey =
  'contribution' | 'trust' | 'participation';

/** One family's earned points against its ceiling. */
export interface PublicEligibilityFamilyScoreDto {
  key: PublicEligibilityFamilyKey;
  points: number;
  cap: number;
}

/** The two hard prerequisites. Both must pass before the score even matters. */
export interface PublicEligibilityGatesDto {
  isVerifiedMet: boolean;
  isTenureMet: boolean;
  /** Days of membership still owed before the tenure gate opens. 0 once met. */
  tenureDaysRemaining: number;
  /** The floor itself, so the client renders it without keeping its own copy. */
  tenureFloorDays: number;
}

/**
 * Why the member may not publish.
 *
 * Coarse on purpose. `not_eligible` is the catch-all the standing veto uses:
 * a member under a moderator takedown must not learn that from this API.
 */
export const PUBLIC_ELIGIBILITY_REASON = {
  NotVerified: 'profile_not_verified',
  TenureTooShort: 'tenure_too_short',
  ScoreBelowTarget: 'score_below_target',
  NotEligible: 'not_eligible',
} as const;

export type PublicEligibilityReasonCode =
  (typeof PUBLIC_ELIGIBILITY_REASON)[keyof typeof PUBLIC_ELIGIBILITY_REASON];

/**
 * The server's authoritative answer to "may this member publish to the open
 * web?". `PUT /me/public-profile` enforces it; the frontend renders it.
 */
export interface PublicEligibilityDecisionDto {
  isEligible: boolean;
  /** `null` exactly when `isEligible` is true. */
  reasonCode: PublicEligibilityReasonCode | null;
  gates: PublicEligibilityGatesDto;
  score: {
    total: number;
    target: number;
    families: PublicEligibilityFamilyScoreDto[];
  };
  isStandingOk: boolean;
}

/**
 * `GET /me/public-eligibility`: every signal plus the decision the server
 * itself would apply on a write. The frontend maps the signals to its
 * `EligibilitySignals` for copy purposes and takes `decision` as the answer,
 * so the client and the write path can never disagree.
 */
export interface PublicEligibilitySignalsDto extends PublicEligibilitySignals {
  decision: PublicEligibilityDecisionDto;
}

/** The service's internally-assembled values, before wire shaping. */
export type RawSignals = PublicEligibilitySignals;

export function toPublicEligibilitySignals(
  raw: RawSignals,
  decision: PublicEligibilityDecisionDto,
): PublicEligibilitySignalsDto {
  return {
    verified: raw.verified,
    tenureDays: raw.tenureDays,
    publishedPieces: raw.publishedPieces,
    hostedOpenEvents: raw.hostedOpenEvents,
    publishedSubprofiles: raw.publishedSubprofiles,
    vouchCount: raw.vouchCount,
    vouchesGivenCount: raw.vouchesGivenCount,
    endorsementCount: raw.endorsementCount,
    connectionCount: raw.connectionCount,
    eventsAttended: raw.eventsAttended,
    communityPosts: raw.communityPosts,
    lastActiveDaysAgo: raw.lastActiveDaysAgo,
    standingOk: raw.standingOk,
    decision,
  };
}
