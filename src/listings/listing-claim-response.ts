import { MemberRef } from '../common/member-ref';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';
import {
  LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
  claimAgeInDays,
  expectedDecisionBy,
} from './listing-claim-policy';

/**
 * The admin-queue + owner-response view of a claim on an existing listing.
 * Carries the target listing's `ref`/`name` (not just its id) so the
 * moderation UI can render/link the row without a second lookup — mirrors
 * `EditSuggestionDTO`'s identical denormalized-for-display convention.
 * `claimant` is `null` once the claimant's account has been erased (the FK is
 * `ON DELETE SET NULL`) — the claim record survives regardless.
 */
export interface ListingClaimDTO {
  id: string;
  listingRef: string;
  listingName: string;
  claimant: MemberRef | null;
  note: string | null;
  status: ListingClaimStatus;
  reviewedBy: string | null;
  /** ISO 8601 timestamp, or `null` while pending. */
  reviewedAt: string | null;
  /** ISO 8601 timestamp. */
  createdAt: string;
  /**
   * The published turnaround, carried on every claim so the status line a
   * claimant reads and the promise the claim form made are the same number.
   * See `listing-claim-policy.ts` for why it lives there and not in a
   * component.
   */
  reviewTurnaroundDays: number;
  /**
   * ISO 8601 date the claimant was told to expect a decision by (filing date
   * plus the turnaround), or `null` once the claim has actually been reviewed
   * and the promise no longer applies. Derived, never stored.
   */
  expectedDecisionBy: string | null;
  /**
   * Whole days this claim has been waiting, so the claimant can be told "filed
   * 6 days ago" rather than being left to work it out from a timestamp. Frozen
   * at the review date once reviewed, so a decided claim stops ageing.
   */
  ageDays: number;
}

export function toListingClaimDTO(
  claim: ListingClaim,
  listing: { ref: string; name: string },
  claimant: MemberRef | null,
): ListingClaimDTO {
  const isPending = claim.reviewedAt === null;
  return {
    id: claim.id,
    listingRef: listing.ref,
    listingName: listing.name,
    claimant,
    note: claim.note,
    status: claim.status,
    reviewedBy: claim.reviewedBy,
    reviewedAt: claim.reviewedAt ? claim.reviewedAt.toISOString() : null,
    createdAt: claim.createdAt.toISOString(),
    reviewTurnaroundDays: LISTING_CLAIM_REVIEW_TURNAROUND_DAYS,
    expectedDecisionBy: isPending
      ? expectedDecisionBy(claim.createdAt).toISOString()
      : null,
    // A reviewed claim stops ageing at its decision, so an approved claim does
    // not keep counting up forever in the claimant's own list.
    ageDays: claimAgeInDays(claim.createdAt, claim.reviewedAt ?? new Date()),
  };
}
