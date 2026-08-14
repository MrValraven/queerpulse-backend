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
}

interface SignalRule {
  perUnit: number;
  cap: number; // maximum units counted
  units: (signals: RecognitionSignals) => number;
}

// Capped per family so no single activity runs away. Tops out near the
// LEVEL_LADDER_DEF span (~3700 XP = Pillar). Tune values here only.
export const XP_RULES: SignalRule[] = [
  {
    perUnit: 50,
    cap: 1,
    units: (signals) => (signals.profileComplete ? 1 : 0),
  },
  { perUnit: 40, cap: 3, units: (signals) => signals.communitiesJoined },
  { perUnit: 40, cap: 3, units: (signals) => signals.personasPublished },
  { perUnit: 60, cap: 10, units: (signals) => signals.vouchCount },
  { perUnit: 25, cap: 20, units: (signals) => signals.connectionCount },
  { perUnit: 50, cap: 12, units: (signals) => signals.eventsAttended },
  { perUnit: 15, cap: 20, units: (signals) => signals.communityPosts },
  { perUnit: 20, cap: 10, units: (signals) => signals.endorsementCount },
  { perUnit: 80, cap: 5, units: (signals) => signals.workshopsTaught },
  { perUnit: 1, cap: 365, units: (signals) => signals.tenureDays },
  { perUnit: 50, cap: 1, units: (signals) => (signals.verified ? 1 : 0) },
  { perUnit: 25, cap: 6, units: (signals) => signals.gettingStartedStepsDone },
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

export function badgeBonusXp(heldBadgeKeys: Iterable<string>): number {
  let bonus = 0;
  for (const badgeKey of heldBadgeKeys) {
    const entry = BADGE_CATALOG.find((badge) => badge.key === badgeKey);
    if (entry) bonus += BADGE_BONUS_BY_RARITY[entry.rarity] ?? 0;
  }
  return bonus;
}

// One predicate per auto-grantable badge key. Keys absent here are never
// auto-granted (e.g. 'founding-member' has no signal yet: it stays in the
// catalog and lights up when a future task adds the signal).
export const BADGE_CONDITIONS: Record<
  string,
  (signals: RecognitionSignals) => boolean
> = {
  'first-gathering': (signals) => signals.eventsAttended >= 1,
  'three-company': (signals) => signals.eventsAttended >= 3,
  'regular-attendee': (signals) => signals.eventsAttended >= 10,
  connector: (signals) => signals.connectionCount >= 10,
  networker: (signals) => signals.connectionCount >= 25,
  vouch: (signals) => signals.vouchCount >= 1,
  'thread-starter': (signals) => signals.communityPosts >= 1,
  contributor: (signals) => signals.communityPosts >= 10,
  decade: (signals) => signals.tenureDays >= 365,
  sustainer: (signals) => signals.tenureDays >= 180,
  'event-host': (signals) => signals.workshopsTaught >= 1,
  'serial-host': (signals) => signals.workshopsTaught >= 5,
  'first-steps': (signals) => signals.gettingStartedComplete,
};

export function qualifyingBadgeKeys(signals: RecognitionSignals): string[] {
  return Object.entries(BADGE_CONDITIONS)
    .filter(([, condition]) => condition(signals))
    .map(([badgeKey]) => badgeKey);
}
