import { MemberRef } from '../common/member-ref';
import {
  ListingClaim,
  ListingClaimStatus,
} from './entities/listing-claim.entity';

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
}

export function toListingClaimDTO(
  claim: ListingClaim,
  listing: { ref: string; name: string },
  claimant: MemberRef | null,
): ListingClaimDTO {
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
  };
}
