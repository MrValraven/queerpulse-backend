import { MemberRef } from '../common/member-ref';
import {
  CommunityOwnerReviewRequest,
  CommunityOwnerReviewRequestStatus,
} from './entities/community-owner-review-request.entity';

/**
 * One owner-review request, as the community's roster sees it. Hand-mapped
 * from `CommunityOwnerReviewRequest` (no global serializer in this repo), so
 * `requestedByUserId` is resolved to the compact `MemberRef` every other
 * community response embeds and never leaves the server as a raw id.
 *
 * `requestedBy` is null when the member who filed it has since erased their
 * account: the FK is `ON DELETE SET NULL` because the request is about the
 * community's governance and has to outlive whoever raised it.
 */
export interface CommunityOwnerReviewRequestDTO {
  id: string;
  status: CommunityOwnerReviewRequestStatus;
  reason: string | null;
  requestedBy: MemberRef | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function toCommunityOwnerReviewRequestDTO(
  request: CommunityOwnerReviewRequest,
  requestedBy: MemberRef | null,
): CommunityOwnerReviewRequestDTO {
  return {
    id: request.id,
    status: request.status,
    reason: request.reason,
    requestedBy,
    createdAt: request.createdAt.toISOString(),
    resolvedAt: request.resolvedAt ? request.resolvedAt.toISOString() : null,
  };
}

/**
 * `GET /communities/:slug/owner-review` — the current state, shaped so the
 * frontend can render the whole surface from one call.
 *
 * Always an OBJECT, even when there is no open request: a Nest handler that
 * returns bare `null` sends an EMPTY body, which the client reads as
 * `undefined` and react-query rejects outright. `request: null` inside a
 * present object is the shape that survives the trip.
 *
 * `needsOwnerReviewAt` is the community's own stamp, which the admin surface
 * queries. It is exposed here because it can also be set by two automatic
 * paths with no request row behind them (`CommunityOwnerOrphanService`, an
 * owner who erased their account with nobody to promote, and
 * `CommunityOwnerInactivityService`, an owner whose sessions have gone quiet
 * past the inactivity cutoff), so "flagged" and "has an open request" are
 * genuinely two different states.
 *
 * `canOpen`/`canWithdraw` are computed for the asking viewer, so the client
 * never has to reimplement the role rules to decide which button to show.
 * Since GOV-02 `canOpen` is true for ANY roster member who is not the owner
 * while no request is open, and the client gates its report control purely on
 * that flag.
 */
export interface CommunityOwnerReviewStateDTO {
  request: CommunityOwnerReviewRequestDTO | null;
  needsOwnerReviewAt: string | null;
  canOpen: boolean;
  canWithdraw: boolean;
}
