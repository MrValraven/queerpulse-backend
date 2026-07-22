import {
  FlatmateProfile,
  FlatmateProfileType,
} from './entities/flatmate-profile.entity';

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const TIMING_WINDOW_DAYS = 31;

/**
 * Deterministic 0..100 compatibility score between a `viewer` and a
 * `candidate` flatmate profile. Only meaningful when the two are OPPOSITE types
 * (one seeking, one offering) — the directory only calls it in that case. Pure;
 * no I/O. Weights: budget 35, neighbourhood 25, lifestyle 25, timing 15.
 */
export function scoreMatch(
  viewer: FlatmateProfile,
  candidate: FlatmateProfile,
): number {
  const seeker =
    viewer.type === FlatmateProfileType.Seeking ? viewer : candidate;
  const offering =
    viewer.type === FlatmateProfileType.Seeking ? candidate : viewer;

  return Math.round(
    budgetFit(seeker.budgetEuros, offering.budgetEuros) +
      neighbourhoodFit(viewer.neighbourhood, candidate.neighbourhood) +
      lifestyleFit(viewer.lifestyleTags, candidate.lifestyleTags) +
      timingFit(viewer, candidate),
  );
}

/** 35 when the room is within budget; linear falloff to 0 once the rent
 * exceeds the seeker's budget by 100% or more. */
function budgetFit(seekerBudget: number, offeringRent: number): number {
  const MAX = 35;
  if (offeringRent <= seekerBudget) return MAX;
  if (seekerBudget <= 0) return 0;
  const over = offeringRent - seekerBudget;
  return Math.max(0, MAX * (1 - over / seekerBudget));
}

/** 25 for the same non-empty neighbourhood (case-insensitive), else 0. */
function neighbourhoodFit(a: string, b: string): number {
  const left = a.trim().toLowerCase();
  const right = b.trim().toLowerCase();
  return left && right && left === right ? 25 : 0;
}

/** 25 scaled by the share of overlapping lifestyle tags. */
function lifestyleFit(a: string[], b: string[]): number {
  const MAX = 25;
  const maxCount = Math.max(a.length, b.length);
  if (maxCount === 0) return 0;
  const set = new Set(a.map((tag) => tag.toLowerCase()));
  const shared = b.filter((tag) => set.has(tag.toLowerCase())).length;
  return MAX * (shared / maxCount);
}

/** 15 when timing is compatible: either side flexible, either move-in unset,
 * or the two move-in dates are within TIMING_WINDOW_DAYS of each other. */
function timingFit(a: FlatmateProfile, b: FlatmateProfile): number {
  const MAX = 15;
  if (a.flexibleTiming || b.flexibleTiming) return MAX;
  if (!a.moveInFrom || !b.moveInFrom) return MAX;
  const diff = Math.abs(
    new Date(a.moveInFrom).getTime() - new Date(b.moveInFrom).getTime(),
  );
  return diff <= TIMING_WINDOW_DAYS * MS_PER_DAY ? MAX : 0;
}
