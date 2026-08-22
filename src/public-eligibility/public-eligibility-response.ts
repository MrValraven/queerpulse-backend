/**
 * The complete eligibility signal set for the signed-in member. The frontend
 * maps this straight to its `EligibilitySignals` and runs the pure evaluator —
 * this endpoint is the single source of truth, so it returns every signal
 * (including verified/tenureDays/vouchCount the profile also carries), not just
 * the "extra" ones. Hand-mapped per repo convention (no global serializer).
 */
export interface PublicEligibilitySignalsDto {
  verified: boolean;
  tenureDays: number;
  /** ISO timestamps of published pieces, most-recent first, capped at 50. */
  publishedPieces: string[];
  /** ISO start times of hosted open+published events, most-recent first, capped at 50. */
  hostedOpenEvents: string[];
  workshopsTaught: number;
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

/** The service's internally-assembled values, before wire shaping. An alias,
 *  not an extending interface: it adds no members, and the name is what
 *  carries the meaning at the call site. */
export type RawSignals = PublicEligibilitySignalsDto;

export function toPublicEligibilitySignals(
  raw: RawSignals,
): PublicEligibilitySignalsDto {
  return {
    verified: raw.verified,
    tenureDays: raw.tenureDays,
    publishedPieces: raw.publishedPieces,
    hostedOpenEvents: raw.hostedOpenEvents,
    workshopsTaught: raw.workshopsTaught,
    publishedSubprofiles: raw.publishedSubprofiles,
    vouchCount: raw.vouchCount,
    vouchesGivenCount: raw.vouchesGivenCount,
    endorsementCount: raw.endorsementCount,
    connectionCount: raw.connectionCount,
    eventsAttended: raw.eventsAttended,
    communityPosts: raw.communityPosts,
    lastActiveDaysAgo: raw.lastActiveDaysAgo,
    standingOk: raw.standingOk,
  };
}
