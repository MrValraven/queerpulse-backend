import {
  PublicEligibilityDecisionDto,
  PublicEligibilityFamilyScoreDto,
  PublicEligibilityReasonCode,
  PUBLIC_ELIGIBILITY_REASON,
  RawSignals,
} from './public-eligibility-response';

/**
 * The public-profile eligibility rule, as executable policy.
 *
 * THIS FILE IS THE SINGLE SOURCE OF TRUTH. The public profile is the one
 * surface that reaches the open web from inside a walled garden, so the
 * decision has to be made where the write happens. It used to live only in the
 * frontend (`queerpulse/src/features/members/publicFigure.ts`), which meant
 * `PUT /me/public-profile` accepted `{ enabled: true }` from a member of one
 * day, or from a stolen session, with no check at all.
 *
 * The numbers below are a faithful port of that frontend evaluator, down to the
 * rounding and the ordering of the contribution series. The frontend keeps the
 * i18n copy that EXPLAINS the rule (labels, hints, "what to do next"), and now
 * renders the numbers this file produces, so the two can no longer drift.
 *
 * Pure: no repositories, no wall clock. `nowIso` is supplied by the caller.
 */

/** Points a member must reach across the three families to unlock. */
export const TARGET_SCORE = 100;

/**
 * A hard prerequisite that the score cannot substitute for: no amount of
 * activity unlocks a public profile before this many days on the platform. QueerPulse is invite-only and
 * trust-first, so being discoverable and citable outside the membership is
 * earned over time. Ninety days is roughly a season: long enough to show a
 * sustained presence, short enough that a genuinely engaged member is not
 * locked out for a year.
 */
export const TENURE_FLOOR_DAYS = 90;

/** Per-family point ceilings. They sum to 115, so no single family unlocks. */
export const CAP = {
  contribution: 50,
  trust: 35,
  participation: 30,
} as const;

/** A published piece older than this many months counts at `RECENCY_DECAY`. */
export const RECENCY_MONTHS = 6;
export const RECENCY_DECAY = 0.5;

/** Being active inside this window is worth a small participation bonus. */
export const ACTIVE_WINDOW_DAYS = 30;

/** Diminishing per-piece value for the contribution family. */
const CONTRIBUTION_SERIES = [20, 12, 8, 6, 4, 3, 2, 1];

const MS_PER_MONTH = 1000 * 60 * 60 * 24 * 30.44;

/** The member-facing 403 text for each reason. Coarse on purpose: see below. */
export const PUBLIC_ELIGIBILITY_REASON_MESSAGE: Record<
  PublicEligibilityReasonCode,
  string
> = {
  [PUBLIC_ELIGIBILITY_REASON.NotVerified]:
    'Your profile has to be verified before it can be published to the open web.',
  [PUBLIC_ELIGIBILITY_REASON.TenureTooShort]: `A public profile unlocks after ${TENURE_FLOOR_DAYS} days of membership.`,
  [PUBLIC_ELIGIBILITY_REASON.ScoreBelowTarget]:
    'You have not reached the contribution threshold for a public profile yet. Your profile page shows what still counts towards it.',
  [PUBLIC_ELIGIBILITY_REASON.NotEligible]:
    'A public profile is not available on this account right now.',
};

/** Months between two ISO timestamps. Pure: parses the given strings only. */
function monthsBetween(fromIso: string, toIso: string): number {
  return (
    (new Date(toIso).getTime() - new Date(fromIso).getTime()) / MS_PER_MONTH
  );
}

function contributionScore(signals: RawSignals, nowIso: string): number {
  const datedWeights = [
    ...signals.publishedPieces,
    ...signals.hostedOpenEvents,
  ].map((publishedAt) =>
    monthsBetween(publishedAt, nowIso) > RECENCY_MONTHS ? RECENCY_DECAY : 1,
  );
  const undatedRecent = signals.publishedSubprofiles;
  for (let index = 0; index < undatedRecent; index += 1) datedWeights.push(1);

  // Full-weight pieces claim the biggest series slots first.
  datedWeights.sort((left, right) => right - left);
  const total = datedWeights.reduce((sum, weight, index) => {
    const seriesValue = CONTRIBUTION_SERIES[index] ?? 1;
    return sum + seriesValue * weight;
  }, 0);
  return Math.min(CAP.contribution, Math.round(total));
}

function trustScore(signals: RawSignals): number {
  let total = 0;
  const vouches = signals.vouchCount;
  if (vouches >= 2) {
    total += 12; // reaching the "2+" bar
    if (vouches >= 3) total += 8; // the 3rd vouch
    total += Math.max(0, vouches - 3) * 5; // each beyond the 3rd
  } else {
    total += vouches * 4; // partial credit so 1 vouch still shows motion
  }
  total += Math.min(10, signals.endorsementCount * 2);
  total += Math.min(6, signals.connectionCount); // cheap to farm, low weight
  return Math.min(CAP.trust, total);
}

function participationScore(signals: RawSignals): number {
  let total = 0;
  total += Math.min(16, signals.eventsAttended * 4);
  total += Math.min(10, signals.communityPosts * 2);
  const beyondFloor = Math.max(0, signals.tenureDays - TENURE_FLOOR_DAYS);
  total += Math.min(8, Math.floor(beyondFloor / 90) * 2);
  if (signals.lastActiveDaysAgo <= ACTIVE_WINDOW_DAYS) total += 6;
  return Math.min(CAP.participation, total);
}

/**
 * Score the signals and decide. Two hard gates, a capped three-family score,
 * and a silent standing veto.
 *
 * The reason code is deliberately coarse. A member who fails the verified or
 * tenure gate is told exactly that, because those are things they can act on
 * and the frontend already explains both. A member vetoed on STANDING gets the
 * generic `not_eligible` instead: telling someone under a moderator takedown
 * that they are under a moderator takedown turns this endpoint into a probe for
 * the moderation queue. The veto stays silent, exactly as the frontend's
 * checklist treats it.
 */
export function evaluatePublicEligibility(
  signals: RawSignals,
  nowIso: string,
): PublicEligibilityDecisionDto {
  const isVerifiedMet = signals.verified === true;
  const isTenureMet = signals.tenureDays >= TENURE_FLOOR_DAYS;
  const isStandingOk = signals.standingOk === true;

  const families: PublicEligibilityFamilyScoreDto[] = [
    {
      key: 'contribution',
      points: contributionScore(signals, nowIso),
      cap: CAP.contribution,
    },
    { key: 'trust', points: trustScore(signals), cap: CAP.trust },
    {
      key: 'participation',
      points: participationScore(signals),
      cap: CAP.participation,
    },
  ];
  const total = Math.min(
    TARGET_SCORE,
    families.reduce((sum, family) => sum + family.points, 0),
  );

  const isEligible =
    isVerifiedMet && isTenureMet && total >= TARGET_SCORE && isStandingOk;

  let reasonCode: PublicEligibilityReasonCode | null = null;
  if (!isEligible) {
    if (!isVerifiedMet) reasonCode = PUBLIC_ELIGIBILITY_REASON.NotVerified;
    else if (!isTenureMet)
      reasonCode = PUBLIC_ELIGIBILITY_REASON.TenureTooShort;
    else if (total < TARGET_SCORE)
      reasonCode = PUBLIC_ELIGIBILITY_REASON.ScoreBelowTarget;
    else reasonCode = PUBLIC_ELIGIBILITY_REASON.NotEligible;
  }

  return {
    isEligible,
    reasonCode,
    gates: {
      isVerifiedMet,
      isTenureMet,
      tenureDaysRemaining: Math.max(0, TENURE_FLOOR_DAYS - signals.tenureDays),
      tenureFloorDays: TENURE_FLOOR_DAYS,
    },
    score: { total, target: TARGET_SCORE, families },
    isStandingOk,
  };
}
