import {
  StudioCopyrightClaim,
  StudioCopyrightClaimStatus,
} from './entities/studio-copyright-claim.entity';
import { studioSafetyError } from './studio-safety.constants';

/*
 * Studio safety and moderation (spec 5.1): the copyright claim's life,
 * spelled once. Every service checks a transition here, under the track and
 * claim row locks, so a status read before the lock never decides anything.
 *
 *   submitted --accept--> accepted --counter--> countered
 *   submitted --decline--> declined
 *   accepted or countered --uphold--> upheld (track stays withheld)
 *   accepted or countered --reject--> rejected (restore rule)
 *   submitted, accepted or countered --withdraw--> withdrawn
 */

export type StudioClaimStaffAction = 'accept' | 'decline' | 'uphold' | 'reject';

export const LIVE_CLAIM_STATUSES: readonly StudioCopyrightClaimStatus[] = [
  StudioCopyrightClaimStatus.Submitted,
  StudioCopyrightClaimStatus.Accepted,
  StudioCopyrightClaimStatus.Countered,
];

/** The live statuses that hold a track withheld: a withdraw from one of
 *  these, and a staff uphold or reject, start from here. An upheld claim
 *  also keeps the track offline; the restore rule reads the wider
 *  `STUDIO_CLAIM_WITHHOLDING_STATUSES`. */
export const HOLDING_CLAIM_STATUSES: readonly StudioCopyrightClaimStatus[] = [
  StudioCopyrightClaimStatus.Accepted,
  StudioCopyrightClaimStatus.Countered,
];

/** What a track's owners may see. Submitted, declined and withdrawn claims
 *  stay hidden from them, whatever stage a claim was withdrawn at. */
export const OWNER_VISIBLE_CLAIM_STATUSES: readonly StudioCopyrightClaimStatus[] =
  [
    StudioCopyrightClaimStatus.Accepted,
    StudioCopyrightClaimStatus.Countered,
    StudioCopyrightClaimStatus.Upheld,
    StudioCopyrightClaimStatus.Rejected,
  ];

/** The staff work queue and its badge: claims waiting on our team. */
export const STAFF_QUEUE_CLAIM_STATUSES: readonly StudioCopyrightClaimStatus[] =
  [StudioCopyrightClaimStatus.Submitted, StudioCopyrightClaimStatus.Countered];

export function isLiveClaimStatus(status: StudioCopyrightClaimStatus): boolean {
  return LIVE_CLAIM_STATUSES.includes(status);
}

export function isHoldingClaimStatus(
  status: StudioCopyrightClaimStatus,
): boolean {
  return HOLDING_CLAIM_STATUSES.includes(status);
}

export function isOwnerVisibleClaimStatus(
  status: StudioCopyrightClaimStatus,
): boolean {
  return OWNER_VISIBLE_CLAIM_STATUSES.includes(status);
}

/** The status a staff action moves a claim to, or the contract refusal. */
export function nextStatusForStaffAction(
  action: StudioClaimStaffAction,
  status: StudioCopyrightClaimStatus,
): StudioCopyrightClaimStatus {
  if (action === 'accept' || action === 'decline') {
    if (status !== StudioCopyrightClaimStatus.Submitted) {
      throw studioSafetyError('studio_claim_not_submitted');
    }
    return action === 'accept'
      ? StudioCopyrightClaimStatus.Accepted
      : StudioCopyrightClaimStatus.Declined;
  }
  if (!isHoldingClaimStatus(status)) {
    throw studioSafetyError('studio_claim_not_decidable');
  }
  return action === 'uphold'
    ? StudioCopyrightClaimStatus.Upheld
    : StudioCopyrightClaimStatus.Rejected;
}

/** One counter-notice, while the claim is accepted. A second counter finds
 *  the claim countered and answers the same refusal. */
export function canCounterClaim(
  claim: Pick<StudioCopyrightClaim, 'status' | 'counterNote'>,
): boolean {
  return (
    claim.status === StudioCopyrightClaimStatus.Accepted &&
    claim.counterNote === null
  );
}

export function assertCounterAllowed(
  claim: Pick<StudioCopyrightClaim, 'status' | 'counterNote'>,
): void {
  if (!canCounterClaim(claim)) {
    throw studioSafetyError('studio_claim_not_accepted');
  }
}

/** One reply to the counter-notice, while the claim is countered. */
export function canReplyToClaim(
  claim: Pick<StudioCopyrightClaim, 'status' | 'claimantReply'>,
): boolean {
  return (
    claim.status === StudioCopyrightClaimStatus.Countered &&
    claim.claimantReply === null
  );
}

export function assertReplyAllowed(
  claim: Pick<StudioCopyrightClaim, 'status' | 'claimantReply'>,
): void {
  if (claim.status !== StudioCopyrightClaimStatus.Countered) {
    throw studioSafetyError('studio_claim_not_countered');
  }
  if (claim.claimantReply !== null) {
    throw studioSafetyError('studio_claim_already_replied');
  }
}

export function canWithdrawClaim(
  claim: Pick<StudioCopyrightClaim, 'status'>,
): boolean {
  return isLiveClaimStatus(claim.status);
}

export function assertWithdrawAllowed(
  claim: Pick<StudioCopyrightClaim, 'status'>,
): void {
  if (!canWithdrawClaim(claim)) {
    throw studioSafetyError('studio_claim_not_live');
  }
}
