/**
 * The published service level for "claim this listing", in ONE place.
 *
 * Claiming a listing is a real ownership request: a moderator reads it, checks
 * the evidence, and on approval hands over a live directory entry along with
 * its reviews, its ref and its history (`ListingClaimsService.review`). Until
 * now nothing anywhere told the claimant how long that takes or what evidence
 * would actually help, so the flow asked someone to describe themselves into a
 * free-text box and then wait an unbounded amount of time. The predictable
 * result is a second, duplicate listing created by the same business a week
 * later, because creating one is instant and claiming one appears to do nothing.
 *
 * Defined here rather than in a frontend component for the obvious reason: the
 * number the claim form promises and the number the claim's own status line
 * counts down against have to be the same number, and a moderation-queue
 * commitment is a backend fact. `GET /listings/claim-policy` serves it, and
 * every claim DTO carries it alongside that claim's own filing date so the two
 * can never drift.
 *
 * WHY FIVE DAYS. A `listing_dispute` report gets a three-day window
 * (`ReportSeverity.Medium`, see `reports/report-severity.ts`), and a claim is
 * the slower sibling of a dispute: nothing is unsafe while it waits, and the
 * decision transfers ownership, so it deserves the extra couple of days rather
 * than a rushed approval. Calendar days, not business days, because a claimant
 * counting on a Friday should not have to work out the platform's working week.
 */
export const LISTING_CLAIM_REVIEW_TURNAROUND_DAYS = 5;

const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * What a claimant can send that actually shortens a review, in the order a
 * moderator finds them most convincing.
 *
 * Server-owned copy, like `reports/report-severity.ts`'s acknowledgement
 * strings: there is no i18n layer on this backend, so these are plain English
 * sentences the frontend renders as written. Every hint is something a person
 * who genuinely runs the place can produce in a few minutes, and none of them
 * asks for a legal document or an identity paper. Requiring paperwork to claim
 * a queer venue would fall hardest on the businesses least likely to have it.
 */
export const LISTING_CLAIM_EVIDENCE_HINTS: readonly string[] = [
  'An email address on the business’s own domain, so we can write back to it.',
  'A post or story from the business’s own social account that mentions the claim.',
  'A public page that already names you: a website team page, a booking profile, a press mention.',
  'A photo from inside the venue that is clearly not one of the public ones already on the listing.',
];

/** The wire shape of `GET /listings/claim-policy`, hand-mapped like every
 *  other response in this module (there is no global serializer). */
export interface ListingClaimPolicyDTO {
  /** Calendar days a claimant should expect to wait for a decision. */
  reviewTurnaroundDays: number;
  /** Ready-to-render sentences describing what evidence helps. */
  evidenceHints: string[];
}

export function toListingClaimPolicyDTO(): ListingClaimPolicyDTO {
  return {
    reviewTurnaroundDays: LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
    evidenceHints: [...LISTING_CLAIM_EVIDENCE_HINTS],
  };
}

/** The date the claimant was promised a decision by, derived from when they
 *  filed. Derivation only, so changing the turnaround above immediately moves
 *  every pending claim's promise instead of leaving stored dates behind. */
export function expectedDecisionBy(filedAt: Date): Date {
  return new Date(
    filedAt.getTime() +
      LISTING_CLAIM_REVIEW_TURNAROUND_DAYS * MILLISECONDS_PER_DAY,
  );
}

/** Whole days a claim has been waiting, floored at 0 so a clock skew can never
 *  render "filed -1 days ago". `now` is injectable for the colocated spec. */
export function claimAgeInDays(filedAt: Date, now: Date = new Date()): number {
  const elapsedMilliseconds = now.getTime() - filedAt.getTime();
  if (elapsedMilliseconds <= 0) return 0;
  return Math.floor(elapsedMilliseconds / MILLISECONDS_PER_DAY);
}
