import { MemberRef } from '../common/member-ref';
import {
  GovernanceProposal,
  GovernanceProposalStatus,
  GovernanceProposalType,
} from './entities/governance-proposal.entity';
import { GovernanceVoteChoice } from './entities/governance-vote.entity';

/** Raw for/against counts for one proposal, live-computed from
 *  `governance_votes` — never a stored/denormalized total. */
export interface ProposalTally {
  for: number;
  against: number;
}

export interface GovernanceProposalTallyDTO {
  for: number;
  against: number;
  /** 0–100, rounded; 0 when no votes have been cast yet (never NaN). */
  forPercent: number;
}

export interface GovernanceProposalDTO {
  id: string;
  type: GovernanceProposalType;
  title: string;
  description: string;
  targetMemberId: string | null;
  /** Resolved display ref for `targetMemberId`, or `null` if there is none
   *  or the account no longer has a profile. */
  targetMember: MemberRef | null;
  status: GovernanceProposalStatus;
  opensAt: string;
  closesAt: string;
  tally: GovernanceProposalTallyDTO;
  /** The calling member's own vote, or `null` if they haven't voted. */
  myVote: GovernanceVoteChoice | null;
}

/** Two-thirds threshold, integer-safe (`for/total >= 2/3` as
 *  `for*3 >= total*2`, so no floating-point comparison). A proposal with zero
 *  votes cast does NOT vacuously pass — it fails for lack of quorum. */
export function proposalOutcome(
  tally: ProposalTally,
): GovernanceProposalStatus.Passed | GovernanceProposalStatus.Failed {
  const total = tally.for + tally.against;
  if (total === 0) return GovernanceProposalStatus.Failed;
  return tally.for * 3 >= total * 2
    ? GovernanceProposalStatus.Passed
    : GovernanceProposalStatus.Failed;
}

function forPercent(tally: ProposalTally): number {
  const total = tally.for + tally.against;
  if (total === 0) return 0;
  return Math.round((tally.for / total) * 100);
}

/**
 * Maps a `GovernanceProposal` + its live tally + the caller's own vote →
 * the response DTO, by hand (no global serializer, per repo convention).
 * `proposal.status` is the value the caller resolved via
 * `GovernanceProposalService.resolveIfClosed` before calling this — this
 * function never re-derives it.
 */
export function toGovernanceProposalDTO(
  proposal: GovernanceProposal,
  tally: ProposalTally,
  myVote: GovernanceVoteChoice | null,
  targetMember: MemberRef | null,
): GovernanceProposalDTO {
  return {
    id: proposal.id,
    type: proposal.type,
    title: proposal.title,
    description: proposal.description,
    targetMemberId: proposal.targetMemberId,
    targetMember,
    status: proposal.status,
    opensAt: proposal.opensAt.toISOString(),
    closesAt: proposal.closesAt.toISOString(),
    tally: {
      for: tally.for,
      against: tally.against,
      forPercent: forPercent(tally),
    },
    myVote,
  };
}
