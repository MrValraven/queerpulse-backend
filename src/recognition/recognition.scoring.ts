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
  /** Open, published gatherings this member hosts or co-hosts, whether or not
   *  they have happened yet. A visibility signal, never an XP one. */
  eventsHosted: number;
  /** Gatherings this member hosted or co-hosted that ALREADY HAPPENED and
   *  drew at least one other person (`PublicEligibilityService
   *  .countHeldGatherings`). The XP and badge unit for hosting: see the
   *  `hosting` rule in XP_RULES for why `eventsHosted` cannot be. */
  eventsHeld: number;
  // ── the contribution side (SUS-05) ────────────────────────────────────────
  // Everything above this line is consumption: showing up, saving, joining,
  // connecting. Everything below is the work the platform depends on. See
  // XP_RULES for why these carry a high per-unit value and a low cap.
  /**
   * Volunteer sessions a POSTER confirmed the member attended
   * (`volunteer_signups.attended = true`) AND recorded hours against
   * (`hours_contributed > 0`). The XP unit is the session and never the hour
   * (see the `volunteering` rule in XP_RULES), which is exactly why the hours
   * floor is here: a confirmation with no hours recorded describes no work,
   * and would otherwise pay the same 120 points as a full Saturday.
   */
  volunteerSessions: number;
  /** Magazine pieces of theirs that reached a published article or deck.
   *  Same definition `public-eligibility.service.ts` already computes. */
  piecesPublished: number;
  /** Public questions on a directory listing that this member answered. */
  directoryAnswers: number;
  /** Resource suggestions of theirs an admin APPROVED. */
  resourcesApproved: number;
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
  | 'tenure'
  | 'verified'
  | 'gettingStarted'
  | 'volunteering'
  | 'hosting'
  | 'magazine'
  | 'answers'
  | 'resources';

interface SignalRule {
  key: XpSourceKey;
  perUnit: number;
  cap: number; // maximum units counted
  units: (signals: RecognitionSignals) => number;
}

/**
 * Capped per family so no single activity runs away. Tune values here only.
 *
 * TWO HALVES, deliberately shaped differently (SUS-05).
 *
 * The consumption half (profile .. gettingStarted) is unchanged and tops out
 * at 3055 XP: many small units, low per-unit value, high caps. It rewards
 * turning up and being present, which is right, and it was the ONLY half that
 * existed. Volunteering on a Saturday, hosting the gathering, writing the
 * piece and answering the question earned nothing at all.
 *
 * The contribution half (volunteering .. resources) is the inverse: high
 * per-unit value, low cap, topping out at 3740 XP. One confirmed volunteer
 * session is worth 120 XP, which is 2.4 RSVPs or two vouches; one published
 * magazine piece is 150. That ratio is the whole point of the item: the work
 * the platform depends on has to outweigh consuming it. The low caps are what
 * stop the ladder going trivial. `LEVEL_LADDER_DEF` needs 3700 XP to reach
 * Pillar, so neither half alone hands it to you, and the two together still
 * take real, sustained effort rather than one busy month.
 *
 * SESSIONS, NOT HOURS, are the volunteering unit. Hours are recorded, summed
 * and reportable (`VolunteeringService.volunteerHoursTotals`), and they are
 * deliberately NOT what XP is paid on. Paying per hour would put an incentive
 * on inflating the exact number the platform intends to show a funder, and it
 * would reward the volunteer whose confirmer is generous over the one whose
 * confirmer is precise. A session is countable and someone other than the
 * volunteer attested it happened.
 */
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

  // ── contribution ──────────────────────────────────────────────────────────
  // A confirmed Saturday: the single heaviest repeatable act on the platform,
  // and the only one a third party has to attest to before it counts.
  {
    key: 'volunteering',
    perUnit: 120,
    cap: 12,
    units: (signals) => signals.volunteerSessions,
  },
  // Hosting pays on `eventsHeld`, never on `eventsHosted`. Creating a
  // published, public gathering is one unguarded API call, and a single
  // recurrence rule expands to 52 independent rows, so `eventsHosted` would
  // have let one request take the whole 800-point cap. XP buys monthly
  // invitations at levels 4 and 5 (`INVITE_QUOTA_BONUS_BY_LEVEL`), so on an
  // invite-gated platform that is an invitation farm. `eventsHeld` requires
  // the date to have passed and someone other than the host to have said they
  // were going: calendar time and another person's cooperation, per gathering.
  {
    key: 'hosting',
    perUnit: 100,
    cap: 8,
    units: (signals) => signals.eventsHeld,
  },
  // The highest per-unit value on the board: a published piece is weeks of
  // work by one person that everyone else reads.
  {
    key: 'magazine',
    perUnit: 150,
    cap: 6,
    units: (signals) => signals.piecesPublished,
  },
  // Answering "is the entrance step-free" once saves the next twenty people
  // asking. Light work, so it sits at the connection rate.
  {
    key: 'answers',
    perUnit: 25,
    cap: 12,
    units: (signals) => signals.directoryAnswers,
  },
  // Only APPROVED suggestions count, so submitting volume earns nothing.
  {
    key: 'resources',
    perUnit: 60,
    cap: 5,
    units: (signals) => signals.resourcesApproved,
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
  // The contribution side's only badges. Both are 'legendary', so each one
  // carries a 150-point badge bonus; leaving them on the free-to-create
  // `eventsHosted` would have kept 300 farmable XP on the board even after
  // the `hosting` rule moved to `eventsHeld`. They read the same held-and-
  // attended unit the XP rule does. NO badge is wired for volunteering,
  // magazine writing, directory answers or resource suggestions, because
  // BADGE_CATALOG holds none for them and this task deliberately did not
  // invent any. Add the catalog entry first and the requirement follows here
  // in one line.
  'event-host': { units: (s) => s.eventsHeld, target: 1 },
  'serial-host': { units: (s) => s.eventsHeld, target: 5 },
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
