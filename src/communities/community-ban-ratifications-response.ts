import { MemberRef } from '../common/member-ref';
import { CommunityBanRuleCitationDTO } from './community-bans-response';
import {
  COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS,
  COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS,
} from './community-ban-ratification-window';
import {
  CommunityBanRatification,
  CommunityBanRatificationStatus,
} from './entities/community-ban-ratification.entity';

/**
 * One permanent community bar waiting on a second signature (PRD-25), for the
 * community's own owner, co-owners and moderators.
 *
 * Mirrors `BanRatificationDTO` in `src/moderation/moderation-response.ts`:
 * `requestedBy` and `note` are the two fields that make the queue usable rather
 * than decorative, because the second signatory has to see WHO asked and in
 * WHOSE WORDS before putting their own name to keeping someone out for good.
 *
 * Hand-mapped, like every response in this module (there is no global
 * serializer), so no raw uuid for a person ever leaves through this route:
 * `member` and `requestedBy` travel as the compact `MemberRef` every other
 * community response embeds. Either can be null when that account has since
 * been erased, and the hold still stands.
 */
export interface CommunityBanRatificationDTO {
  id: string;
  member: MemberRef | null;
  /** The name snapshot taken when the bar was proposed. Still correct after
   *  the member erases their account, which is exactly the case a removal
   *  record has to survive. */
  memberName: string;
  requestedBy: MemberRef | null;
  /** The proposer's own words, as written on the removal. */
  note: string | null;
  rule: CommunityBanRuleCitationDTO | null;
  /** What the member is serving while the hold stands. Always
   *  `removed_and_barred_30_days` today; carried explicitly so the pane states
   *  it rather than the reader inferring it. */
  interimAction: string;
  /** When the 30-day bar the proposal put in force ends by itself, ISO 8601.
   *  Null once a ratified hold has made the bar permanent. */
  barExpiresAt: string | null;
  requestedAt: string;
  /** When the hold lapses if nobody signs, ISO 8601. */
  expiresAt: string;
  /** True once `expiresAt` has passed and the lazy sweep has not run yet. The
   *  pane greys such a row rather than offering a sign button that would
   *  refuse. */
  isExpired: boolean;
  /** True when the viewer proposed this bar and so may not sign it. The guard
   *  is enforced server-side either way; this is what lets the pane say why
   *  the button is not there. */
  isOwnProposal: boolean;
  status: CommunityBanRatificationStatus;
  decidedBy: MemberRef | null;
  decidedAt: string | null;
  decisionNote: string | null;
}

/** The whole pending queue for one community, soonest to lapse first. */
export interface CommunityBanRatificationListDTO {
  ratifications: CommunityBanRatificationDTO[];
  total: number;
  /** How long a proposal waits for its second signature. Server-owned so the
   *  pane never hard-codes the number in copy. */
  windowHours: number;
  /** What an unsigned proposal settles at. Same reasoning. */
  fallbackDays: number;
}

/**
 * The cited rule on a hold, or null when the proposal cites nothing. Returns
 * null unless all three snapshot columns are present, matching
 * `toCommunityBanRuleCitationDTO`: a partial citation would render as a rule
 * number with no words behind it.
 */
function toHoldRuleCitation(
  hold: CommunityBanRatification,
  currentRulesVersion: number,
): CommunityBanRuleCitationDTO | null {
  if (
    hold.ruleIndex === null ||
    hold.ruleVersion === null ||
    hold.ruleText === null
  ) {
    return null;
  }
  return {
    index: hold.ruleIndex,
    version: hold.ruleVersion,
    text: hold.ruleText,
    isStale: hold.ruleVersion !== currentRulesVersion,
  };
}

export function toCommunityBanRatificationDTO(
  hold: CommunityBanRatification,
  member: MemberRef | null,
  requestedBy: MemberRef | null,
  decidedBy: MemberRef | null,
  currentRulesVersion: number,
  viewerUserId: string,
  barExpiresAt: Date | null,
  now: Date = new Date(),
): CommunityBanRatificationDTO {
  return {
    id: hold.id,
    member,
    memberName: hold.targetName ?? 'Member',
    requestedBy,
    note: hold.note,
    rule: toHoldRuleCitation(hold, currentRulesVersion),
    interimAction: hold.interimAction,
    barExpiresAt: barExpiresAt ? barExpiresAt.toISOString() : null,
    requestedAt: hold.createdAt.toISOString(),
    expiresAt: hold.expiresAt.toISOString(),
    isExpired:
      hold.status === CommunityBanRatificationStatus.Pending &&
      hold.expiresAt.getTime() <= now.getTime(),
    isOwnProposal: hold.requestedBy === viewerUserId,
    status: hold.status,
    decidedBy,
    decidedAt: hold.decidedAt ? hold.decidedAt.toISOString() : null,
    decisionNote: hold.decisionNote,
  };
}

/**
 * What `DELETE /communities/:slug/members/:memberSlug` now answers with
 * (PRD-25).
 *
 * The route used to be a bare 204. That was fine while a removal had exactly
 * one possible outcome; it is not fine now that asking for a permanent bar can
 * land in three different places (waiting on a second signature, standing as 30
 * days because this community has nobody else who could sign, or unchanged
 * because a `banDays` term was given). A moderator who is told nothing will
 * believe they did the thing they asked for, and in one of those three cases
 * they did not.
 */
export interface CommunityRemovalOutcomeDTO {
  /** The member is off the roster. True in every case this response is
   *  returned at all: the removal never waits on anything. */
  isRemoved: true;
  /** True when the removal also barred the return. False for `allowReturn` and
   *  for every self-leave. */
  hasBarredReturn: boolean;
  /** When the bar ends by itself, ISO 8601. Null when there is no bar, or when
   *  the bar on file was already permanent. */
  barExpiresAt: string | null;
  /** True when a permanent bar was asked for and is now waiting on a second
   *  owner, co-owner or moderator. */
  isPendingRatification: boolean;
  /** The hold, so the caller can link straight to the pane. Null when none
   *  opened. */
  ratificationId: string | null;
  /** When that hold lapses if nobody signs, ISO 8601. Null when none opened. */
  ratificationExpiresAt: string | null;
  /** True when a permanent bar was asked for and this community has nobody
   *  else who could sign it, so the bar stands at the fallback term. The case
   *  a solo owner meets, and the one this response exists to say out loud. */
  hasNoSecondSignatory: boolean;
  /** One plain sentence the caller can show as-is. Server-owned so the
   *  three-way outcome is never reconstructed client-side from booleans. */
  message: string;
}

function formatBarDate(barExpiresAt: Date): string {
  return barExpiresAt.toISOString().slice(0, 10);
}

/**
 * The outcome sentence. Written so the moderator reads what actually happened
 * before they read anything about process: the member is out, here is how long
 * for, and here is what is still needed.
 */
export function communityRemovalMessage(input: {
  isSelfLeave: boolean;
  hasBarredReturn: boolean;
  barExpiresAt: Date | null;
  isPendingRatification: boolean;
  hasNoSecondSignatory: boolean;
}): string {
  if (input.isSelfLeave) return 'You left the community.';
  if (!input.hasBarredReturn) {
    return 'Removed from the community. They can join again.';
  }
  if (input.isPendingRatification) {
    return (
      `Removed and barred for ${COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days. ` +
      'A permanent bar needs a second signature from another owner, co-owner ' +
      `or moderator, and it has ${COMMUNITY_BAN_RATIFICATION_WINDOW_HOURS} hours. ` +
      `Without one the bar stays at ${COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days.`
    );
  }
  if (input.hasNoSecondSignatory) {
    return (
      `Removed and barred for ${COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days. ` +
      'A permanent bar needs a second signature, and this community has ' +
      `nobody else who could give one, so the bar stands at ` +
      `${COMMUNITY_BAN_UNRATIFIED_FALLBACK_DAYS} days.`
    );
  }
  if (input.barExpiresAt) {
    return `Removed and barred from returning until ${formatBarDate(input.barExpiresAt)}.`;
  }
  return 'Removed and barred from returning.';
}

export function toCommunityRemovalOutcomeDTO(input: {
  isSelfLeave: boolean;
  hasBarredReturn: boolean;
  barExpiresAt: Date | null;
  ratificationId: string | null;
  ratificationExpiresAt: Date | null;
  hasNoSecondSignatory: boolean;
}): CommunityRemovalOutcomeDTO {
  const isPendingRatification = input.ratificationId !== null;
  return {
    isRemoved: true,
    hasBarredReturn: input.hasBarredReturn,
    barExpiresAt: input.barExpiresAt ? input.barExpiresAt.toISOString() : null,
    isPendingRatification,
    ratificationId: input.ratificationId,
    ratificationExpiresAt: input.ratificationExpiresAt
      ? input.ratificationExpiresAt.toISOString()
      : null,
    hasNoSecondSignatory: input.hasNoSecondSignatory,
    message: communityRemovalMessage({
      isSelfLeave: input.isSelfLeave,
      hasBarredReturn: input.hasBarredReturn,
      barExpiresAt: input.barExpiresAt,
      isPendingRatification,
      hasNoSecondSignatory: input.hasNoSecondSignatory,
    }),
  };
}
