import type { IndependentVisitTally } from '../safe-space-vouches/safe-space-visits.service';
import type {
  SafeSpaceBadgeSuspension,
  SafeSpaceSuspensionCause,
} from './entities/safe-space-badge-suspension.entity';
import type {
  SafeSpaceFlag,
  SafeSpaceFlagReason,
  SafeSpaceFlagResolution,
} from './entities/safe-space-flag.entity';
import type { SafeSpaceDecisionAudit } from './entities/safe-space-decision-audit.entity';
import {
  SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD,
  isDueForReReview,
  reReviewDueAt,
} from './safe-space-policy';

/**
 * The honest states a safe-space badge can be in, which is more than the three
 * `listings.safe_space_status` carries.
 *
 * `verified` and `suspended` are BOTH backed by a real grant. The difference is
 * whether that grant currently speaks for the place: a suspended badge has an
 * open review against it and must not render as verified anywhere, while the
 * grant itself is untouched and comes back when the review closes.
 * `under_review` is a place with no badge yet whose nomination is live, which
 * is the state the three member visits are collected in.
 */
export type SafeSpaceBadgeState =
  'none' | 'under_review' | 'verified' | 'suspended' | 'removed';

/**
 * `GET /safe-spaces/:slug/badge-state` — what a member is entitled to know
 * about a badge before they trust it.
 *
 * DELIBERATELY ABSENT: any flag count, any flagger identity, any flag reason.
 * A member is told a space is under review; they are never told how many
 * people said so or who. Publishing a running flag tally would turn a safety
 * mechanism into a public pillory and would make flagging unsafe for the
 * person doing it. The counts live behind the moderator-guarded flag queue.
 */
export interface SafeSpaceBadgeStateResponse {
  listingId: string;
  slug: string;
  state: SafeSpaceBadgeState;
  tier: number | null;
  /** The free-text provenance line, e.g. "Mod team, 3 member visits". */
  verifier: string | null;
  /** When the badge was granted or last re-verified (`YYYY-MM-DD`). */
  badgeAwardedAt: string | null;
  reReviewDueAt: string | null;
  isDueForReReview: boolean;
  /** True while a nomination is open on it, or a suspension stands. */
  isUnderReview: boolean;
  suspendedAt: string | null;
  /** Platform- or moderator-authored, and never naming a flagger. */
  suspensionReason: string | null;
  visits: {
    independentVisitCount: number;
    requiredVisitCount: number;
    hasMetVisitBar: boolean;
  };
  /** The published "three flags trigger a review" number, so the UI never
   * hardcodes it. Not a count of anything. */
  flagThreshold: number;
  /** Whether the CURRENT viewer has an open flag on this space. Their own
   * fact about themselves, so the flag button can read "flagged". */
  viewerHasFlagged: boolean;
}

export function toSafeSpaceBadgeStateResponse(input: {
  listingId: string;
  slug: string;
  safeSpaceStatus: string;
  tier: number | null;
  verifier: string;
  badgeAwardedAt: string | null;
  suspension: SafeSpaceBadgeSuspension | null;
  hasOpenNomination: boolean;
  visits: IndependentVisitTally;
  viewerHasFlagged: boolean;
  now?: Date;
}): SafeSpaceBadgeStateResponse {
  const now = input.now ?? new Date();
  const isSuspended = input.suspension !== null;
  const due = reReviewDueAt(input.badgeAwardedAt);
  let state: SafeSpaceBadgeState;
  if (input.safeSpaceStatus === 'removed') {
    state = 'removed';
  } else if (input.safeSpaceStatus === 'verified') {
    state = isSuspended ? 'suspended' : 'verified';
  } else {
    state = input.hasOpenNomination ? 'under_review' : 'none';
  }
  return {
    listingId: input.listingId,
    slug: input.slug,
    state,
    tier: input.tier,
    verifier: input.verifier || null,
    badgeAwardedAt: input.badgeAwardedAt,
    reReviewDueAt: due?.toISOString() ?? null,
    isDueForReReview:
      state === 'verified' && isDueForReReview(input.badgeAwardedAt, now),
    isUnderReview: isSuspended || input.hasOpenNomination,
    suspendedAt: input.suspension?.createdAt.toISOString() ?? null,
    suspensionReason: input.suspension?.reason ?? null,
    visits: {
      independentVisitCount: input.visits.independentVisitCount,
      requiredVisitCount: input.visits.requiredVisitCount,
      hasMetVisitBar: input.visits.hasMetVisitBar,
    },
    flagThreshold: SAFE_SPACE_FLAG_SUSPENSION_THRESHOLD,
    viewerHasFlagged: input.viewerHasFlagged,
  };
}

/** Lifecycle of one flag, as either side of the queue reads it. */
export type SafeSpaceFlagState = 'open' | 'withdrawn' | 'resolved';

export function safeSpaceFlagState(flag: SafeSpaceFlag): SafeSpaceFlagState {
  if (flag.withdrawnAt) return 'withdrawn';
  if (flag.resolvedAt) return 'resolved';
  return 'open';
}

/**
 * What the FLAGGER is told about their own flag. Nobody else ever receives
 * this shape: it is returned only from the routes that already resolve the
 * caller's own row.
 */
export interface MemberSafeSpaceFlagResponse {
  id: string;
  listingSlug: string;
  reasonCode: SafeSpaceFlagReason;
  state: SafeSpaceFlagState;
  createdAt: string;
  resolvedAt: string | null;
  resolution: SafeSpaceFlagResolution | null;
  /** True when this call found an existing open flag rather than writing a new
   * one, so a double tap reads as "already flagged" instead of an error. */
  wasAlreadyFlagged: boolean;
}

export function toMemberSafeSpaceFlagResponse(
  flag: SafeSpaceFlag,
  listingSlug: string,
  wasAlreadyFlagged = false,
): MemberSafeSpaceFlagResponse {
  return {
    id: flag.id,
    listingSlug,
    reasonCode: flag.reasonCode,
    state: safeSpaceFlagState(flag),
    createdAt: flag.createdAt.toISOString(),
    resolvedAt: flag.resolvedAt?.toISOString() ?? null,
    resolution: flag.resolution,
    wasAlreadyFlagged,
  };
}

/**
 * The moderator's view of a flag. This is the ONLY shape in the codebase that
 * carries `flaggerId` or the flagger's free-text `detail`, and it is served
 * only from `@Roles(Moderator, Admin)` routes. The venue owner never receives
 * it, in whole or in part.
 */
export interface AdminSafeSpaceFlagResponse {
  id: string;
  listingId: string;
  listingSlug: string | null;
  listingName: string | null;
  flaggerId: string | null;
  reasonCode: SafeSpaceFlagReason;
  detail: string | null;
  state: SafeSpaceFlagState;
  createdAt: string;
  withdrawnAt: string | null;
  resolvedAt: string | null;
  resolvedBy: string | null;
  resolution: SafeSpaceFlagResolution | null;
  resolutionNote: string | null;
}

export function toAdminSafeSpaceFlagResponse(
  flag: SafeSpaceFlag,
  listing?: { slug: string; name: string } | null,
): AdminSafeSpaceFlagResponse {
  return {
    id: flag.id,
    listingId: flag.listingId,
    listingSlug: listing?.slug ?? null,
    listingName: listing?.name ?? null,
    flaggerId: flag.flaggerId,
    reasonCode: flag.reasonCode,
    detail: flag.detail,
    state: safeSpaceFlagState(flag),
    createdAt: flag.createdAt.toISOString(),
    withdrawnAt: flag.withdrawnAt?.toISOString() ?? null,
    resolvedAt: flag.resolvedAt?.toISOString() ?? null,
    resolvedBy: flag.resolvedBy,
    resolution: flag.resolution,
    resolutionNote: flag.resolutionNote,
  };
}

/** One row of the moderator-only audit trail. */
export interface SafeSpaceAuditResponse {
  id: string;
  subjectType: string;
  subjectId: string;
  listingId: string | null;
  action: string;
  actorId: string | null;
  reason: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export function toSafeSpaceAuditResponse(
  audit: SafeSpaceDecisionAudit,
): SafeSpaceAuditResponse {
  return {
    id: audit.id,
    subjectType: audit.subjectType,
    subjectId: audit.subjectId,
    listingId: audit.listingId,
    action: audit.action,
    actorId: audit.actorId,
    reason: audit.reason,
    metadata: audit.metadata ?? {},
    createdAt: audit.createdAt.toISOString(),
  };
}

/** One space whose badge has been speaking for itself for over a year. */
export interface SafeSpaceReReviewDueResponse {
  listingId: string;
  ref: string;
  slug: string;
  name: string;
  tier: number | null;
  badgeAwardedAt: string | null;
  reReviewDueAt: string | null;
  /** Whole days past due, so the queue can sort by how stale it is. */
  daysOverdue: number;
  isBadgeSuspended: boolean;
  openFlagCount: number;
}

/**
 * A badge suspension as the moderator console reads it. Hand-mapped like every
 * other response here: the entity is never returned raw.
 */
export interface AdminSafeSpaceSuspensionResponse {
  id: string;
  listingId: string;
  cause: SafeSpaceSuspensionCause;
  flagCountAtSuspension: number;
  suspendedBy: string | null;
  reason: string | null;
  createdAt: string;
  liftedAt: string | null;
  liftedBy: string | null;
  liftReason: string | null;
  isOpen: boolean;
}

export function toAdminSafeSpaceSuspensionResponse(
  suspension: SafeSpaceBadgeSuspension,
): AdminSafeSpaceSuspensionResponse {
  return {
    id: suspension.id,
    listingId: suspension.listingId,
    cause: suspension.cause,
    flagCountAtSuspension: suspension.flagCountAtSuspension,
    suspendedBy: suspension.suspendedBy,
    reason: suspension.reason,
    createdAt: suspension.createdAt.toISOString(),
    liftedAt: suspension.liftedAt?.toISOString() ?? null,
    liftedBy: suspension.liftedBy,
    liftReason: suspension.liftReason,
    isOpen: suspension.liftedAt === null,
  };
}
