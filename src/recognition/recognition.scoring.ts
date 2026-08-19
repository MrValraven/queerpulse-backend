import { BADGE_CATALOG } from './recognition.catalog';

export interface RecognitionSignals {
  profileComplete: boolean;
  communitiesJoined: number;
  personasPublished: number;
  vouchCount: number;
  connectionCount: number;
  eventsAttended: number;
  communityPosts: number;
  endorsementCount: number;
  workshopsTaught: number;
  tenureDays: number;
  verified: boolean;
  gettingStartedStepsDone: number; // 0..6
  gettingStartedComplete: boolean;
  listingsSaved: number;
  articlesSaved: number;
  workProfileComplete: boolean;
}

/** Stable identifier for one XP-earning category, exposed to the frontend via
 *  `xpBreakdown()` so it can resolve its own label/icon (I never encode
 *  display text here — see `recognition-response.ts`'s `XpBreakdownItemDTO`). */
export type XpSourceKey =
  | 'profile'
  | 'communities'
  | 'personas'
  | 'vouches'
  | 'connections'
  | 'events'
  | 'posts'
  | 'endorsements'
  | 'workshops'
  | 'tenure'
  | 'verified'
  | 'gettingStarted';

interface SignalRule {
  key: XpSourceKey;
  perUnit: number;
  cap: number; // maximum units counted
  units: (signals: RecognitionSignals) => number;
}

// Capped per family so no single activity runs away. Tops out near the
// LEVEL_LADDER_DEF span (~3700 XP = Pillar). Tune values here only.
export const XP_RULES: SignalRule[] = [
  {
    key: 'profile',
    perUnit: 50,
    cap: 1,
    units: (signals) => (signals.profileComplete ? 1 : 0),
  },
  {
    key: 'communities',
    perUnit: 40,
    cap: 3,
    units: (signals) => signals.communitiesJoined,
  },
  {
    key: 'personas',
    perUnit: 40,
    cap: 3,
    units: (signals) => signals.personasPublished,
  },
  {
    key: 'vouches',
    perUnit: 60,
    cap: 10,
    units: (signals) => signals.vouchCount,
  },
  {
    key: 'connections',
    perUnit: 25,
    cap: 20,
    units: (signals) => signals.connectionCount,
  },
  {
    key: 'events',
    perUnit: 50,
    cap: 12,
    units: (signals) => signals.eventsAttended,
  },
  {
    key: 'posts',
    perUnit: 15,
    cap: 20,
    units: (signals) => signals.communityPosts,
  },
  {
    key: 'endorsements',
    perUnit: 20,
    cap: 10,
    units: (signals) => signals.endorsementCount,
  },
  {
    key: 'workshops',
    perUnit: 80,
    cap: 5,
    units: (signals) => signals.workshopsTaught,
  },
  {
    key: 'tenure',
    perUnit: 1,
    cap: 365,
    units: (signals) => signals.tenureDays,
  },
  {
    key: 'verified',
    perUnit: 50,
    cap: 1,
    units: (signals) => (signals.verified ? 1 : 0),
  },
  {
    key: 'gettingStarted',
    perUnit: 25,
    cap: 6,
    units: (signals) => signals.gettingStartedStepsDone,
  },
];

export const BADGE_BONUS_BY_RARITY: Record<string, number> = {
  common: 40,
  rare: 80,
  legendary: 150,
};

export function scoreSignals(signals: RecognitionSignals): number {
  return XP_RULES.reduce((total, rule) => {
    const units = Math.max(
      0,
      Math.min(rule.cap, Math.floor(rule.units(signals))),
    );
    return total + units * rule.perUnit;
  }, 0);
}

export interface XpBreakdownItem {
  key: XpSourceKey;
  units: number;
  cap: number;
  perUnit: number;
  xp: number;
}

/** Same math as `scoreSignals`, itemized per source instead of summed — the
 *  "what you did to earn it" list. Computed fresh from live signals, so it
 *  can drift slightly from the stored (no-regression) total XP if a signal
 *  ever decreases; that's an accepted, informational tradeoff. */
export function xpBreakdown(signals: RecognitionSignals): XpBreakdownItem[] {
  return XP_RULES.map((rule) => {
    const units = Math.max(
      0,
      Math.min(rule.cap, Math.floor(rule.units(signals))),
    );
    return {
      key: rule.key,
      units,
      cap: rule.cap,
      perUnit: rule.perUnit,
      xp: units * rule.perUnit,
    };
  });
}

export function badgeBonusXp(heldBadgeKeys: Iterable<string>): number {
  let bonus = 0;
  for (const badgeKey of heldBadgeKeys) {
    const entry = BADGE_CATALOG.find((badge) => badge.key === badgeKey);
    if (entry) bonus += BADGE_BONUS_BY_RARITY[entry.rarity] ?? 0;
  }
  return bonus;
}

/** One requirement per auto-grantable badge key: how many `units` of a
 *  signal a member currently has, and the `target` needed to earn it. Keys
 *  absent here are never auto-granted (e.g. 'founding-member' has no signal
 *  yet: it stays in the catalog and lights up when a future task adds one).
 *  A single declaration backs both the boolean earned-check
 *  (`qualifyingBadgeKeys`) and the frontend's locked-badge progress readout
 *  (`badgeProgress`) — one source of truth, no threshold duplicated. Boolean
 *  signals (e.g. `gettingStartedComplete`) coerce to 0/1 units against a
 *  target of 1. */
export interface BadgeRequirement {
  units: (signals: RecognitionSignals) => number;
  target: number;
}

export const BADGE_REQUIREMENTS: Record<string, BadgeRequirement> = {
  'first-gathering': { units: (s) => s.eventsAttended, target: 1 },
  'three-company': { units: (s) => s.eventsAttended, target: 3 },
  'regular-attendee': { units: (s) => s.eventsAttended, target: 10 },
  connector: { units: (s) => s.connectionCount, target: 10 },
  networker: { units: (s) => s.connectionCount, target: 25 },
  vouch: { units: (s) => s.vouchCount, target: 1 },
  'thread-starter': { units: (s) => s.communityPosts, target: 1 },
  contributor: { units: (s) => s.communityPosts, target: 10 },
  'two-homes': { units: (s) => s.communitiesJoined, target: 2 },
  decade: { units: (s) => s.tenureDays, target: 365 },
  sustainer: { units: (s) => s.tenureDays, target: 180 },
  'event-host': { units: (s) => s.workshopsTaught, target: 1 },
  'serial-host': { units: (s) => s.workshopsTaught, target: 5 },
  'first-steps': {
    units: (s) => (s.gettingStartedComplete ? 1 : 0),
    target: 1,
  },
  'local-scout': { units: (s) => s.listingsSaved, target: 3 },
  'well-read': { units: (s) => s.articlesSaved, target: 5 },
  'work-ready': { units: (s) => (s.workProfileComplete ? 1 : 0), target: 1 },
};

export function isBadgeEarned(
  badgeKey: string,
  signals: RecognitionSignals,
): boolean {
  const requirement = BADGE_REQUIREMENTS[badgeKey];
  return requirement ? requirement.units(signals) >= requirement.target : false;
}

export function qualifyingBadgeKeys(signals: RecognitionSignals): string[] {
  return Object.keys(BADGE_REQUIREMENTS).filter((badgeKey) =>
    isBadgeEarned(badgeKey, signals),
  );
}

export interface BadgeProgress {
  units: number;
  target: number;
}

/** `{units, target}` for a locked badge's progress readout, or `undefined`
 *  when the badge has no wired requirement (progress tracking isn't
 *  guessable, so the frontend falls back to a binary locked state). `units`
 *  is clamped to `[0, target]` — raw signal values can exceed the target. */
export function badgeProgress(
  badgeKey: string,
  signals: RecognitionSignals,
): BadgeProgress | undefined {
  const requirement = BADGE_REQUIREMENTS[badgeKey];
  if (!requirement) return undefined;
  const units = Math.max(
    0,
    Math.min(requirement.target, Math.floor(requirement.units(signals))),
  );
  return { units, target: requirement.target };
}
