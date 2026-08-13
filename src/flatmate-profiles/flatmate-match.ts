import {
  FlatmateHouseholdNorms,
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMING_WINDOW_DAYS = 31;

/**
 * The compatibility factors that make up a match, each a stable key the
 * frontend maps to a translated label. Ordered roughly by weight; `budget` and
 * `neighbourhood` are the practical basics, `safeSpace`/`household` are the
 * affirming-fit signals added on top.
 */
export type MatchFactor =
  | 'budget'
  | 'neighbourhood'
  | 'lifestyle'
  | 'timing'
  | 'safeSpace'
  | 'household';

/**
 * Re-balanced weights. They sum to 100 so `score` reads as a percentage. Kept
 * here as the single source of truth for both scoring and the reasons list.
 *
 *   budget 25 · neighbourhood 20 · lifestyle 15 · timing 10 · safeSpace 15 · household 15
 */
export const MATCH_WEIGHTS: Record<MatchFactor, number> = {
  budget: 25,
  neighbourhood: 20,
  lifestyle: 15,
  timing: 10,
  safeSpace: 15,
  household: 15,
};

/** A dealbreaker floors the score to this ceiling — the pair can still appear,
 * but never reads as a strong match. */
const DEALBREAKER_SCORE_CEILING = 30;

/** One explainable reason a viewer and a candidate matched. `label` is an
 * English, human-readable summary that is ALREADY GDPR-redacted (generic when
 * the viewer may not see the candidate's special-category specifics), so it is
 * always safe to render. `contribution` is the points earned out of `weight`. */
export interface MatchReason {
  factor: MatchFactor;
  label: string;
  weight: number;
  contribution: number;
}

/** Structured, explainable match. `score` is 0..100; `reasons` are the positive
 * factors ordered by contribution (best first); `dealbreaker` flags a hard
 * household incompatibility that floored the score. */
export interface MatchResult {
  score: number;
  reasons: MatchReason[];
  dealbreaker: boolean;
}

export interface ScoreMatchOptions {
  /** Whether the viewer is permitted to see the candidate's special-category
   * details (per `canRevealIdentity`). Gates the SPECIFICS in the safe-space
   * reason — never the score itself, which the engine may always compute. */
  revealCandidateIdentity: boolean;
}

/**
 * Deterministic, explainable compatibility between a `viewer` and a `candidate`
 * flatmate profile. Only meaningful when the two are OPPOSITE types (one
 * seeking, one offering) — the directory only calls it in that case. Pure; no
 * I/O; no randomness.
 *
 * GDPR: safe-space needs are Art.9 special-category. The engine scores over the
 * candidate's needs server-side, but the returned reason only NAMES the shared
 * needs when `options.revealCandidateIdentity` is true — otherwise it falls back
 * to a generic "Shared safe-space values" label so nothing leaks to a viewer the
 * candidate has not permitted.
 */
export function scoreMatch(
  viewer: FlatmateProfile,
  candidate: FlatmateProfile,
  options: ScoreMatchOptions = { revealCandidateIdentity: false },
): MatchResult {
  const seeker =
    viewer.type === FlatmateProfileType.Seeking ? viewer : candidate;
  const offering =
    viewer.type === FlatmateProfileType.Seeking ? candidate : viewer;

  const household = householdCompatibility(
    viewer.householdNorms,
    candidate.householdNorms,
  );

  const reasons: MatchReason[] = [
    budgetReason(seeker.budgetEuros, offering.budgetEuros),
    neighbourhoodReason(viewer.neighbourhood, candidate.neighbourhood),
    lifestyleReason(viewer.lifestyleTags, candidate.lifestyleTags),
    timingReason(viewer, candidate),
    safeSpaceReason(
      viewer.safeSpaceNeeds,
      candidate.safeSpaceNeeds,
      options.revealCandidateIdentity,
    ),
    household.reason,
  ];

  const rawScore = reasons.reduce(
    (total, reason) => total + reason.contribution,
    0,
  );
  const dealbreaker = household.dealbreaker;
  const score = Math.round(
    dealbreaker ? Math.min(rawScore, DEALBREAKER_SCORE_CEILING) : rawScore,
  );

  // Only positive factors are worth showing, best first.
  const positiveReasons = reasons
    .filter((reason) => reason.contribution > 0)
    .sort((left, right) => right.contribution - left.contribution);

  return { score, reasons: positiveReasons, dealbreaker };
}

/** 25 when the room is within budget; linear falloff to 0 once the rent exceeds
 * the seeker's budget by 100% or more. */
function budgetReason(seekerBudget: number, offeringRent: number): MatchReason {
  const weight = MATCH_WEIGHTS.budget;
  let contribution = 0;
  if (offeringRent <= seekerBudget) {
    contribution = weight;
  } else if (seekerBudget > 0) {
    const over = offeringRent - seekerBudget;
    contribution = Math.max(0, weight * (1 - over / seekerBudget));
  }
  return {
    factor: 'budget',
    label:
      contribution >= weight
        ? 'Budget and rent line up'
        : 'Budget is roughly in range',
    weight,
    contribution,
  };
}

/** 20 for the same non-empty neighbourhood (case-insensitive), else 0. */
function neighbourhoodReason(left: string, right: string): MatchReason {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  const contribution = a && b && a === b ? MATCH_WEIGHTS.neighbourhood : 0;
  return {
    factor: 'neighbourhood',
    label: 'Same neighbourhood',
    weight: MATCH_WEIGHTS.neighbourhood,
    contribution,
  };
}

/** 15 scaled by the share of overlapping lifestyle tags. */
function lifestyleReason(left: string[], right: string[]): MatchReason {
  const weight = MATCH_WEIGHTS.lifestyle;
  const maxCount = Math.max(left.length, right.length);
  const shared = overlapCount(left, right);
  const contribution = maxCount === 0 ? 0 : weight * (shared / maxCount);
  return {
    factor: 'lifestyle',
    label:
      shared > 1
        ? 'Several lifestyle tags in common'
        : 'A shared lifestyle tag',
    weight,
    contribution,
  };
}

/** 10 when timing is compatible: either side flexible, either move-in unset, or
 * the two move-in dates fall within TIMING_WINDOW_DAYS of each other. */
function timingReason(a: FlatmateProfile, b: FlatmateProfile): MatchReason {
  const weight = MATCH_WEIGHTS.timing;
  const contribution = timingFits(a, b) ? weight : 0;
  return {
    factor: 'timing',
    label: 'Move-in timing works',
    weight,
    contribution,
  };
}

function timingFits(a: FlatmateProfile, b: FlatmateProfile): boolean {
  if (a.flexibleTiming || b.flexibleTiming) return true;
  if (!a.moveInFrom || !b.moveInFrom) return true;
  const diff = Math.abs(
    new Date(a.moveInFrom).getTime() - new Date(b.moveInFrom).getTime(),
  );
  return diff <= TIMING_WINDOW_DAYS * MS_PER_DAY;
}

/**
 * 15 scaled by the overlap in affirming safe-space needs. Special-category, so
 * the reason only names the shared needs when the viewer is permitted; otherwise
 * it stays generic. The SCORE is identical either way — redaction touches the
 * words the viewer reads, never the ranking.
 */
function safeSpaceReason(
  viewerNeeds: string[] | null,
  candidateNeeds: string[] | null,
  revealSpecifics: boolean,
): MatchReason {
  const weight = MATCH_WEIGHTS.safeSpace;
  const left = viewerNeeds ?? [];
  const right = candidateNeeds ?? [];
  const maxCount = Math.max(left.length, right.length);
  const shared = sharedValues(left, right);
  const contribution = maxCount === 0 ? 0 : weight * (shared.length / maxCount);
  const label =
    revealSpecifics && shared.length > 0
      ? `Shared safe-space values: ${shared.join(', ')}`
      : 'Shared safe-space values';
  return { factor: 'safeSpace', label, weight, contribution };
}

/** Per-norm alignment: 1 aligned, 0.5 loosely compatible, 0 conflicting. Only
 * norms BOTH people filled count. A hard conflict (e.g. non-smoking vs smoking
 * indoors) flags a dealbreaker. `outAtHome` lives in the gated identity struct,
 * not here — this factor is ordinary shared-living data only. */
function householdCompatibility(
  viewerNorms: FlatmateHouseholdNorms | null,
  candidateNorms: FlatmateHouseholdNorms | null,
): { reason: MatchReason; dealbreaker: boolean } {
  const weight = MATCH_WEIGHTS.household;
  const viewer = viewerNorms ?? {};
  const candidate = candidateNorms ?? {};

  const keys: (keyof FlatmateHouseholdNorms)[] = [
    'smoking',
    'pets',
    'guests',
    'cleanliness',
    'sleepSchedule',
    'noise',
    'sharing',
  ];

  let considered = 0;
  let alignment = 0;
  let dealbreaker = false;
  for (const key of keys) {
    const mine = viewer[key];
    const theirs = candidate[key];
    if (!mine || !theirs) continue;
    considered += 1;
    if (isHardConflict(key, mine, theirs)) {
      dealbreaker = true;
      // contributes 0
    } else if (mine.trim().toLowerCase() === theirs.trim().toLowerCase()) {
      alignment += 1;
    } else {
      alignment += 0.5;
    }
  }

  const contribution = considered === 0 ? 0 : weight * (alignment / considered);
  return {
    reason: {
      factor: 'household',
      label: dealbreaker
        ? 'A household basic clashes'
        : 'Household basics agree',
      weight,
      contribution,
    },
    dealbreaker,
  };
}

/** Deterministic, order-independent hard-conflict pairs. These are the only
 * combinations that floor a match — everything else is a soft preference. */
const HARD_CONFLICTS: Partial<
  Record<keyof FlatmateHouseholdNorms, [string, string][]>
> = {
  smoking: [['Non-smoking home', 'Smoking OK']],
  pets: [['No pets', 'Already have pets']],
};

function isHardConflict(
  key: keyof FlatmateHouseholdNorms,
  a: string,
  b: string,
): boolean {
  const pairs = HARD_CONFLICTS[key];
  if (!pairs) return false;
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return pairs.some(([first, second]) => {
    const one = first.toLowerCase();
    const two = second.toLowerCase();
    return (left === one && right === two) || (left === two && right === one);
  });
}

function overlapCount(left: string[], right: string[]): number {
  return sharedValues(left, right).length;
}

/** Case-insensitive intersection, preserving the left side's original casing. */
function sharedValues(left: string[], right: string[]): string[] {
  const rightSet = new Set(right.map((value) => value.trim().toLowerCase()));
  return left.filter((value) => rightSet.has(value.trim().toLowerCase()));
}
