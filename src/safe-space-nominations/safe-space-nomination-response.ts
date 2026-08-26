import type { IndependentVisitTally } from '../safe-space-vouches/safe-space-visits.service';
import type { SafeSpaceNomination } from './entities/safe-space-nomination.entity';
import {
  SAFE_SPACE_ACKNOWLEDGEMENT_HOURS,
  acknowledgementDueAt,
  ageInHours,
} from './safe-space-policy';

/**
 * Client-facing shape of a nomination, for the member who submitted it.
 * Hand-mapped from the entity (this codebase has no global serializer) so a
 * column added to the table never leaks onto the wire by accident.
 *
 * It carries the platform's side of the promise back to the nominator: when it
 * was received, when acknowledgement fell due, whether it has been
 * acknowledged, and what was eventually decided and why. It carries NO
 * moderator identity: which member of staff acted is an internal fact.
 */
export interface SafeSpaceNominationResponse {
  id: string;
  placeName: string;
  address: string | null;
  placeType: string | null;
  listingRef: string | null;
  reason: string | null;
  status: string;
  createdAt: string;
  /** Alias of `createdAt`, named for what the clock actually measures. */
  receivedAt: string;
  /** `receivedAt` + 48 hours: the acknowledgement the copy promises. */
  acknowledgementDueAt: string;
  acknowledgedAt: string | null;
  decidedAt: string | null;
  /** The moderator's written reason, addressed to this nominator. */
  decisionReason: string | null;
  awardedTier: number | null;
}

/** The listing a nomination is under review against, as the queue shows it. */
export interface AdminNominationListingSummary {
  id: string;
  ref: string;
  slug: string;
  name: string;
  safeSpaceStatus: string;
  /** True while an unlifted suspension stands against the badge. */
  isBadgeSuspended: boolean;
  /** `listings.safe_space_re_verified_at` — when the badge was last granted. */
  badgeAwardedAt: string | null;
  reReviewDueAt: string | null;
  isDueForReReview: boolean;
  /** Open flags standing against the space. Moderator-only. */
  openFlagCount: number;
}

/**
 * Admin queue row — everything a person needs to decide without opening
 * another tab.
 *
 * `nominatorId` is `null` when the nominator's account has since been erased
 * (`SetNullContentAuthorFksOnUserErasure1794610000000`). The nomination stays
 * in the moderation queue on its own merits; there is simply no member left to
 * open from the row, so the admin surface renders it unattributed.
 */
export interface AdminSafeSpaceNominationResponse extends SafeSpaceNominationResponse {
  nominatorId: string | null;
  acknowledgedBy: string | null;
  assignedAt: string | null;
  assignedBy: string | null;
  assignmentNote: string | null;
  decidedBy: string | null;
  reopenedAt: string | null;
  listingId: string | null;

  // --- The 48-hour promise, precomputed so the queue can sort on it ---
  /** Whole hours since the nomination was received. */
  ageHours: number;
  acknowledgementWindowHours: number;
  /** Still unacknowledged and already past the promised window. */
  hasBreachedAcknowledgement: boolean;
  /** Acknowledged, but after the window had already closed. */
  wasAcknowledgedLate: boolean;

  // --- The three-visit bar. `null` until the nomination is assigned to a
  // listing, because a visit count with nothing to count against would read as
  // "nobody has been" when the truth is "we have not said where". ---
  visits: {
    independentVisitCount: number;
    requiredVisitCount: number;
    hasMetVisitBar: boolean;
    notIndependentVouchCount: number;
  } | null;

  listing: AdminNominationListingSummary | null;
}

export function toSafeSpaceNominationResponse(
  nomination: SafeSpaceNomination,
): SafeSpaceNominationResponse {
  return {
    id: nomination.id,
    placeName: nomination.placeName,
    address: nomination.address,
    placeType: nomination.placeType,
    listingRef: nomination.listingRef,
    reason: nomination.reason,
    status: nomination.status,
    createdAt: nomination.createdAt.toISOString(),
    receivedAt: nomination.createdAt.toISOString(),
    acknowledgementDueAt: acknowledgementDueAt(
      nomination.createdAt,
    ).toISOString(),
    acknowledgedAt: nomination.acknowledgedAt?.toISOString() ?? null,
    decidedAt: nomination.decidedAt?.toISOString() ?? null,
    decisionReason: nomination.decisionReason,
    awardedTier: nomination.awardedTier,
  };
}

export function toAdminSafeSpaceNominationResponse(
  nomination: SafeSpaceNomination,
  context: {
    visits?: IndependentVisitTally | null;
    listing?: AdminNominationListingSummary | null;
    now?: Date;
  } = {},
): AdminSafeSpaceNominationResponse {
  const now = context.now ?? new Date();
  const dueAt = acknowledgementDueAt(nomination.createdAt);
  const visits = context.visits ?? null;
  return {
    ...toSafeSpaceNominationResponse(nomination),
    nominatorId: nomination.nominatorId,
    acknowledgedBy: nomination.acknowledgedBy,
    assignedAt: nomination.assignedAt?.toISOString() ?? null,
    assignedBy: nomination.assignedBy,
    assignmentNote: nomination.assignmentNote,
    decidedBy: nomination.decidedBy,
    reopenedAt: nomination.reopenedAt?.toISOString() ?? null,
    listingId: nomination.listingId,
    ageHours: ageInHours(nomination.createdAt, now),
    acknowledgementWindowHours: SAFE_SPACE_ACKNOWLEDGEMENT_HOURS,
    hasBreachedAcknowledgement:
      nomination.acknowledgedAt === null && now.getTime() > dueAt.getTime(),
    wasAcknowledgedLate:
      nomination.acknowledgedAt !== null &&
      nomination.acknowledgedAt.getTime() > dueAt.getTime(),
    visits: visits
      ? {
          independentVisitCount: visits.independentVisitCount,
          requiredVisitCount: visits.requiredVisitCount,
          hasMetVisitBar: visits.hasMetVisitBar,
          notIndependentVouchCount: visits.notIndependentVouchCount,
        }
      : null,
    listing: context.listing ?? null,
  };
}
