import { MemberRef } from '../common/member-ref';
import {
  GovernanceProposal,
  GovernanceProposalStatus,
  GovernanceProposalType,
} from './entities/governance-proposal.entity';
import { GovernanceVoteChoice } from './entities/governance-vote.entity';

/**
 * How many members must stand behind a motion before it reaches staff
 * screening (GOV-01). The proposer counts as the first, so this is "the
 * proposer plus nine".
 *
 * Frozen onto each motion as `cosignatureThreshold` at filing time, so
 * changing this constant never moves the bar for a drive already running.
 */
export const COSIGNATURE_THRESHOLD = 10;

/** Quorum is this percentage of the currently active membership. */
export const QUORUM_PERCENT_OF_ACTIVE = 10;

/**
 * The floor quorum never drops below, however small the community is. Without
 * it a young platform would let three votes decide a governance question, and
 * a two-thirds majority of three people is not a community decision.
 */
export const QUORUM_FLOOR = 10;

/** How long a co-signature drive has before the motion lapses. */
export const GATHERING_WINDOW_DAYS = 30;

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
  /**
   * How many ballots this proposal needs for the result to count. The CURRENT
   * requirement while the proposal is `open` (so the page can render the
   * progress bar live), the frozen `finalQuorumRequired` once it has resolved,
   * and `null` where quorum does not apply yet (a motion still gathering
   * co-signatures or awaiting screening) or was never recorded (a proposal
   * resolved before quorum existed).
   */
  quorumRequired: number | null;
  /** `for + against` — what gets compared against `quorumRequired`. */
  totalVotes: number;
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
  /**
   * True only when this proposal `failed` because too few members voted, as
   * opposed to failing on the two-thirds majority. Deliberately false whenever
   * `finalQuorumRequired` is NULL: a proposal resolved before quorum existed
   * has no recorded bar, and claiming it missed one would be an invention.
   */
  failedForQuorum: boolean;

  // ── Member motions (GOV-01). Zero/null on an admin-opened proposal. ──────
  /** Live count of `governance_proposal_cosignatures` rows. */
  cosignatureCount: number;
  /** The bar frozen at filing time; `null` on an admin-opened proposal. */
  cosignatureThreshold: number | null;
  /** Whether the calling member has already co-signed. */
  hasCosigned: boolean;
  proposedByMemberId: string | null;
  /** Resolved display ref for `proposedByMemberId`, resolved through the same
   *  `MemberLookup` batch as `targetMember`. */
  proposedByMember: MemberRef | null;
  gatheringClosesAt: string | null;
  /** The reason staff gave when they approved or rejected the motion. */
  screeningNote: string | null;
}

/**
 * How many ballots a proposal needs before its result counts: whichever is
 * larger of `QUORUM_FLOOR` and `QUORUM_PERCENT_OF_ACTIVE`% of the active
 * membership, rounded up.
 *
 * `Math.ceil` rather than `Math.round` so the bar is never quietly below the
 * stated percentage.
 */
export function quorumRequiredFor(activeMemberCount: number): number {
  return Math.max(
    QUORUM_FLOOR,
    Math.ceil((activeMemberCount * QUORUM_PERCENT_OF_ACTIVE) / 100),
  );
}

/**
 * The outcome of a closed proposal: it passes only if BOTH gates clear.
 *
 *  1. Quorum — at least `quorumRequired` members actually voted. Without this
 *     a proposal decided by two people carried the same weight as one decided
 *     by two hundred, which is the live correctness problem here: a
 *     "two-thirds community vote" that four members can settle is not a
 *     community vote.
 *  2. Two-thirds majority, integer-safe (`for/total >= 2/3` written as
 *     `for*3 >= total*2`, so no floating-point comparison).
 *
 * A proposal with zero votes cast does NOT vacuously pass — it fails at the
 * quorum gate.
 */
export function proposalOutcome(
  tally: ProposalTally,
  quorumRequired: number,
): GovernanceProposalStatus.Passed | GovernanceProposalStatus.Failed {
  const totalVotes = tally.for + tally.against;
  if (totalVotes < quorumRequired) return GovernanceProposalStatus.Failed;
  return tally.for * 3 >= totalVotes * 2
    ? GovernanceProposalStatus.Passed
    : GovernanceProposalStatus.Failed;
}

function forPercent(tally: ProposalTally): number {
  const total = tally.for + tally.against;
  if (total === 0) return 0;
  return Math.round((tally.for / total) * 100);
}

/**
 * Which quorum number to show for a proposal in its current state. `open`
 * renders the CURRENT requirement so the bar moves with the community;
 * anything resolved renders the frozen one, which is the bar its own outcome
 * was actually judged against.
 */
function displayQuorumRequired(
  proposal: GovernanceProposal,
  currentQuorumRequired: number,
): number | null {
  if (proposal.status === GovernanceProposalStatus.Open) {
    return currentQuorumRequired;
  }
  if (
    proposal.status === GovernanceProposalStatus.Passed ||
    proposal.status === GovernanceProposalStatus.Failed
  ) {
    return proposal.finalQuorumRequired;
  }
  // gathering / screening / rejected / lapsed: no ballot ever happened, so
  // there is no quorum to report.
  return null;
}

/** Everything the mapper needs beyond the row itself. Passed as one object
 *  rather than eight positional arguments, which had stopped being readable
 *  once motions arrived. */
export interface GovernanceProposalDTOInput {
  proposal: GovernanceProposal;
  tally: ProposalTally;
  myVote: GovernanceVoteChoice | null;
  targetMember: MemberRef | null;
  proposedByMember: MemberRef | null;
  cosignatureCount: number;
  hasCosigned: boolean;
  /** The quorum requirement derived from the CURRENT active member count. */
  currentQuorumRequired: number;
}

/**
 * Maps a `GovernanceProposal` + its live tally + the caller's own vote →
 * the response DTO, by hand (no global serializer, per repo convention).
 * `proposal.status` is the value the caller resolved via
 * `GovernanceProposalService.resolveIfClosed` before calling this — this
 * function never re-derives it.
 */
export function toGovernanceProposalDTO(
  input: GovernanceProposalDTOInput,
): GovernanceProposalDTO {
  const { proposal, tally } = input;
  const totalVotes = tally.for + tally.against;
  const quorumRequired = displayQuorumRequired(
    proposal,
    input.currentQuorumRequired,
  );
  const failedForQuorum =
    proposal.status === GovernanceProposalStatus.Failed &&
    proposal.finalQuorumRequired !== null &&
    totalVotes < proposal.finalQuorumRequired;

  return {
    id: proposal.id,
    type: proposal.type,
    title: proposal.title,
    description: proposal.description,
    targetMemberId: proposal.targetMemberId,
    targetMember: input.targetMember,
    status: proposal.status,
    opensAt: proposal.opensAt.toISOString(),
    closesAt: proposal.closesAt.toISOString(),
    tally: {
      for: tally.for,
      against: tally.against,
      forPercent: forPercent(tally),
      quorumRequired,
      totalVotes,
    },
    myVote: input.myVote,
    failedForQuorum,
    cosignatureCount: input.cosignatureCount,
    cosignatureThreshold: proposal.cosignatureThreshold,
    hasCosigned: input.hasCosigned,
    proposedByMemberId: proposal.proposedByMemberId,
    proposedByMember: input.proposedByMember,
    gatheringClosesAt: proposal.gatheringClosesAt
      ? proposal.gatheringClosesAt.toISOString()
      : null,
    screeningNote: proposal.screeningNote,
  };
}
