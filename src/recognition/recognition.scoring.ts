import { BADGE_CATALOG } from './recognition.catalog';

export interface RecognitionSignals {
  profileComplete: boolean;
  /** Every roster row this member holds, including the ones written for them
   *  by founding a community. A readout and getting-started-checklist number
   *  only: `audiencedCommunities` is the XP and badge unit. */
  communitiesJoined: number;
  /** Communities holding at least two people besides this member
   *  (`PublicEligibilityService.countAudiencedCommunities`). The XP and badge
   *  unit: see the `communities` rule in XP_RULES for why `communitiesJoined`
   *  cannot be. */
  audiencedCommunities: number;
  personasPublished: number;
  vouchCount: number;
  connectionCount: number;
  /** Every past `going` RSVP, a host's RSVP to their own gathering included.
   *  A readout number only: `gatheringsAttended` is the XP and badge unit. */
  eventsAttended: number;
  /** Past gatherings this member went to that somebody else was running
   *  (`PublicEligibilityService.countAttendedGatherings`). The XP and badge
   *  unit: see the `events` rule in XP_RULES for why `eventsAttended` cannot
   *  be. */
  gatheringsAttended: number;
  /** Everything this member has written across the forum and communities. A
   *  readout and getting-started-checklist number only:
   *  `engagedCommunityPosts` is the XP and badge unit. */
  communityPosts: number;
  /** Posts and replies of theirs with a second person on the other end
   *  (`PublicEligibilityService.countEngagedCommunityPosts`). The XP and
   *  badge unit: see the `posts` rule in XP_RULES for why `communityPosts`
   *  cannot be. */
  engagedCommunityPosts: number;
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
  /**
   * Whether one unit of this signal costs the earner somebody else: another
   * member's cooperation, or a moderator's decision.
   *
   * THIS FLAG IS LOAD-BEARING, not documentation. XP buys extra monthly
   * invitations at levels 4 and 5 (`INVITE_QUOTA_BONUS_BY_LEVEL`), so on an
   * invite-only platform a signal one person can drive alone is an invitation
   * printer. `soloXpCeiling()` sums every rule marked `false` here and
   * `recognition.scoring.spec.ts` asserts that total stays below the XP that
   * reaches level 4, which is the invariant: NOBODY REACHES INVITE QUOTA
   * ALONE. A new rule added with `needsSecondParty: false` and a fat cap
   * fails that assertion rather than quietly reopening the hole.
   */
  needsSecondParty: boolean;
  units: (signals: RecognitionSignals) => number;
}

/**
 * Capped per family so no single activity runs away. Tune values here only.
 *
 * A THIRD AXIS, added after PRD-05, cuts across both halves below:
 * `needsSecondParty`. XP buys extra monthly invitations at levels 4 and 5
 * (`INVITE_QUOTA_BONUS_BY_LEVEL`), and on an invite-only platform built for
 * people who are not safe everywhere, invitations are the membrane. So a
 * signal one person can drive on their own is an invitation printer, and the
 * audit found several: twenty posts in a community the poster founded and
 * nobody joined paid the full 300, twelve `going` RSVPs a host left on their
 * own backdated gatherings paid 600, three self-founded communities paid 120,
 * and the badges reading those same raw counts paid 280 more. Together with
 * tenure that reached level 6 with nobody else on the platform involved.
 *
 * Each rule now declares whether a unit costs the earner somebody else, the
 * counts behind the gated ones live in `PublicEligibilityService` next to
 * `countHeldGatherings` which was the first fix of this shape, and
 * `soloXpCeiling()` totals what is left of the solo path so a test can hold
 * it below level 4 forever.
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
  // Solo, and one-shot: your own avatar and bio, worth 50 XP once, forever.
  {
    key: 'profile',
    perUnit: 50,
    cap: 1,
    needsSecondParty: false,
    units: (signals) => (signals.profileComplete ? 1 : 0),
  },
  // Pays on `audiencedCommunities`, never on `communitiesJoined`. Founding a
  // community is one API call and `CommunitiesService.create` writes the
  // founder onto its roster, with no cap on how many they may found, so the
  // raw roster count handed the whole 120 XP to three requests and nobody
  // else was ever in the room. `audiencedCommunities` needs two other people
  // on the roster.
  {
    key: 'communities',
    perUnit: 40,
    cap: 3,
    needsSecondParty: true,
    units: (signals) => signals.audiencedCommunities,
  },
  // Solo, and capped: a persona is a member's own public face, and publishing
  // one is entirely their own act. 120 XP is the lifetime total.
  {
    key: 'personas',
    perUnit: 40,
    cap: 3,
    needsSecondParty: false,
    units: (signals) => signals.personasPublished,
  },
  // Vouches GIVEN, and `VouchService.createVouch` refuses a self-vouch and
  // resolves the vouchee through an active-user join, so each unit names a
  // different real account.
  {
    key: 'vouches',
    perUnit: 60,
    cap: 10,
    needsSecondParty: true,
    units: (signals) => signals.vouchCount,
  },
  // Accepted connections only (`ConnectionsService.counts`), so the other
  // side pressed accept.
  {
    key: 'connections',
    perUnit: 25,
    cap: 20,
    needsSecondParty: true,
    units: (signals) => signals.connectionCount,
  },
  // Pays on `gatheringsAttended`, never on `eventsAttended`. A host's own
  // `going` RSVP to their own gathering counted, and `EventsService.update`
  // validates the schedule with `rejectPast: false`, so a host could create a
  // gathering, backdate it, RSVP and collect. Attending now means a gathering
  // somebody else was running.
  {
    key: 'events',
    perUnit: 50,
    cap: 12,
    needsSecondParty: true,
    units: (signals) => signals.gatheringsAttended,
  },
  // Pays on `engagedCommunityPosts`, never on `communityPosts`. The raw count
  // was the member's own keystrokes: twenty posts in a community they founded
  // and nobody joined paid the full 300 XP. Every unit now has a second
  // person on the other end of it, either as the audience or as the person
  // being answered.
  {
    key: 'posts',
    perUnit: 15,
    cap: 20,
    needsSecondParty: true,
    units: (signals) => signals.engagedCommunityPosts,
  },
  // Endorsements RECEIVED on this member's personas.
  // `SubprofileEndorsementsService.endorse` refuses a self-endorsement.
  {
    key: 'endorsements',
    perUnit: 20,
    cap: 10,
    needsSecondParty: true,
    units: (signals) => signals.endorsementCount,
  },
  // Solo, and deliberately left that way. Tenure is the one signal nobody can
  // farm: it cannot be scripted, parallelised or hurried, it pays 1 XP for
  // one day and there is no second day to buy. Capping it lower would punish
  // members for the passage of time. It is 365 of the 685 solo ceiling, which
  // is why every OTHER solo rule has to stay small.
  {
    key: 'tenure',
    perUnit: 1,
    cap: 365,
    needsSecondParty: false,
    units: (signals) => signals.tenureDays,
  },
  // An admin sets `profiles.verified`.
  {
    key: 'verified',
    perUnit: 50,
    cap: 1,
    needsSecondParty: true,
    units: (signals) => (signals.verified ? 1 : 0),
  },
  // Solo on paper, and capped at six steps for life. Two of the six steps
  // (vouch for someone, make a connection) do need another member, so 100 of
  // the 150 is the real solo reach. `soloXpCeiling()` counts the full 150
  // anyway: a ceiling that assumes the best case is not a ceiling.
  {
    key: 'gettingStarted',
    perUnit: 25,
    cap: 6,
    needsSecondParty: false,
    units: (signals) => signals.gettingStartedStepsDone,
  },

  // ── contribution ──────────────────────────────────────────────────────────
  // A confirmed Saturday: the single heaviest repeatable act on the platform,
  // and the only one a third party has to attest to before it counts.
  {
    key: 'volunteering',
    perUnit: 120,
    cap: 12,
    needsSecondParty: true,
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
    needsSecondParty: true,
    units: (signals) => signals.eventsHeld,
  },
  // The highest per-unit value on the board: a published piece is weeks of
  // work by one person that everyone else reads.
  {
    key: 'magazine',
    perUnit: 150,
    cap: 6,
    needsSecondParty: true,
    units: (signals) => signals.piecesPublished,
  },
  // Answering "is the entrance step-free" once saves the next twenty people
  // asking. Light work, so it sits at the connection rate.
  {
    key: 'answers',
    perUnit: 25,
    cap: 12,
    needsSecondParty: true,
    units: (signals) => signals.directoryAnswers,
  },
  // Only APPROVED suggestions count, so submitting volume earns nothing.
  {
    key: 'resources',
    perUnit: 60,
    cap: 5,
    needsSecondParty: true,
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

/**
 * The most XP one person can reach with nobody else involved: every rule
 * marked `needsSecondParty: false` at its full cap, plus the badge bonuses
 * those same solo signals can unlock.
 *
 * It exists to be asserted against. Level 4 is where XP starts buying extra
 * monthly invitations (`INVITE_QUOTA_BONUS_BY_LEVEL`), and
 * `recognition.scoring.spec.ts` pins this number below `levelStartXp(4)`, so
 * a future rule that reopens a solo path to invite quota breaks a test
 * instead of shipping. Today it is 685 against a level-4 start of 950:
 * a complete profile (50), three published personas (120), a full year of
 * tenure (365) and the whole getting-started checklist (150).
 */
export function soloXpCeiling(): number {
  const fromSignals = XP_RULES.filter((rule) => !rule.needsSecondParty).reduce(
    (total, rule) => total + rule.cap * rule.perUnit,
    0,
  );
  const fromBadges = Object.keys(BADGE_REQUIREMENTS).reduce(
    (total, badgeKey) =>
      BADGE_REQUIREMENTS[badgeKey]!.needsSecondParty
        ? total
        : total + badgeBonusFor(badgeKey),
    0,
  );
  return fromSignals + fromBadges;
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

/**
 * The XP bonus one badge is worth, which is its rarity value for a badge
 * somebody else was part of earning, and ZERO for a badge a member earns
 * entirely alone.
 *
 * The badge is still awarded, still displayed, and still says on the profile
 * what the member did. What a solo badge stops carrying is the XP, because XP
 * is convertible into monthly invitations and a bonus is the one part of a
 * badge that a farmer wants. Saving three places, saving five articles,
 * filling in a work profile and simply still being here after six months and
 * a year were 320 XP of pure keep-to-yourself activity, on top of the 365
 * that tenure already pays for the same waiting. Tenure paid twice for one
 * signal; the saved-item badges paid for bookmarking.
 *
 * A badge key with no `BADGE_REQUIREMENTS` entry (`founding-member`) is never
 * auto-granted, so it never reaches here; it answers 0 rather than throwing.
 */
export function badgeBonusFor(badgeKey: string): number {
  const requirement = BADGE_REQUIREMENTS[badgeKey];
  if (!requirement || !requirement.needsSecondParty) return 0;
  const entry = BADGE_CATALOG.find((badge) => badge.key === badgeKey);
  return entry ? (BADGE_BONUS_BY_RARITY[entry.rarity] ?? 0) : 0;
}

export function badgeBonusXp(heldBadgeKeys: Iterable<string>): number {
  let bonus = 0;
  for (const badgeKey of heldBadgeKeys) bonus += badgeBonusFor(badgeKey);
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
  /**
   * Whether earning this badge takes somebody other than the member. Read by
   * `badgeBonusFor`, which pays the rarity bonus only for a badge that does,
   * and by `soloXpCeiling()`. A badge a member reaches alone is still awarded
   * and still shown; it carries no XP.
   */
  needsSecondParty: boolean;
}

export const BADGE_REQUIREMENTS: Record<string, BadgeRequirement> = {
  // Every attendance, posting and community badge reads the SAME gated unit
  // its XP rule reads. Leaving them on the raw counts would have kept the
  // farm alive through the badge bonus after the XP rule closed it, which is
  // the mistake the `event-host` note below records being caught once
  // already.
  'first-gathering': {
    units: (signals) => signals.gatheringsAttended,
    target: 1,
    needsSecondParty: true,
  },
  'three-company': {
    units: (signals) => signals.gatheringsAttended,
    target: 3,
    needsSecondParty: true,
  },
  'regular-attendee': {
    units: (signals) => signals.gatheringsAttended,
    target: 10,
    needsSecondParty: true,
  },
  connector: {
    units: (signals) => signals.connectionCount,
    target: 10,
    needsSecondParty: true,
  },
  networker: {
    units: (signals) => signals.connectionCount,
    target: 25,
    needsSecondParty: true,
  },
  vouch: {
    units: (signals) => signals.vouchCount,
    target: 1,
    needsSecondParty: true,
  },
  'thread-starter': {
    units: (signals) => signals.engagedCommunityPosts,
    target: 1,
    needsSecondParty: true,
  },
  contributor: {
    units: (signals) => signals.engagedCommunityPosts,
    target: 10,
    needsSecondParty: true,
  },
  'two-homes': {
    units: (signals) => signals.audiencedCommunities,
    target: 2,
    needsSecondParty: true,
  },
  // Time served, which nobody else is part of. The badge is awarded and
  // displayed; `tenure` already pays 1 XP a day for the identical signal, so
  // the bonus would be the same waiting paid twice.
  decade: {
    units: (signals) => signals.tenureDays,
    target: 365,
    needsSecondParty: false,
  },
  sustainer: {
    units: (signals) => signals.tenureDays,
    target: 180,
    needsSecondParty: false,
  },
  // The contribution side's only badges. Both are 'legendary', so each one
  // carries a 150-point badge bonus; leaving them on the free-to-create
  // `eventsHosted` would have kept 300 farmable XP on the board even after
  // the `hosting` rule moved to `eventsHeld`. They read the same held-and-
  // attended unit the XP rule does. NO badge is wired for volunteering,
  // magazine writing, directory answers or resource suggestions, because
  // BADGE_CATALOG holds none for them and this task deliberately did not
  // invent any. Add the catalog entry first and the requirement follows here
  // in one line.
  'event-host': {
    units: (signals) => signals.eventsHeld,
    target: 1,
    needsSecondParty: true,
  },
  'serial-host': {
    units: (signals) => signals.eventsHeld,
    target: 5,
    needsSecondParty: true,
  },
  // Two of the six checklist steps are "vouch for someone else" and "make a
  // connection", so finishing it is not a solo act.
  'first-steps': {
    units: (signals) => (signals.gettingStartedComplete ? 1 : 0),
    target: 1,
    needsSecondParty: true,
  },
  // Bookmarking and filling in your own fields. Private, unilateral, and
  // unlimited in supply, so the badge is the whole reward.
  'local-scout': {
    units: (signals) => signals.listingsSaved,
    target: 3,
    needsSecondParty: false,
  },
  'well-read': {
    units: (signals) => signals.articlesSaved,
    target: 5,
    needsSecondParty: false,
  },
  'work-ready': {
    units: (signals) => (signals.workProfileComplete ? 1 : 0),
    target: 1,
    needsSecondParty: false,
  },
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
