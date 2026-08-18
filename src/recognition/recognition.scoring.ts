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
  'two-homes': (signals) => signals.communitiesJoined >= 2,
  decade: (signals) => signals.tenureDays >= 365,
  sustainer: (signals) => signals.tenureDays >= 180,
  'event-host': (signals) => signals.workshopsTaught >= 1,
  'serial-host': (signals) => signals.workshopsTaught >= 5,
  'first-steps': (signals) => signals.gettingStartedComplete,
  'local-scout': (signals) => signals.listingsSaved >= 3,
  'well-read': (signals) => signals.articlesSaved >= 5,
  'work-ready': (signals) => signals.workProfileComplete,
};

export function qualifyingBadgeKeys(signals: RecognitionSignals): string[] {
  return Object.entries(BADGE_CONDITIONS)
    .filter(([, condition]) => condition(signals))
    .map(([badgeKey]) => badgeKey);
}
