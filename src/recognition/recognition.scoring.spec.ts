import { levelStartXp } from './recognition.catalog';
import {
  RecognitionSignals,
  badgeBonusFor,
  badgeProgress,
  scoreSignals,
  badgeBonusXp,
  isBadgeEarned,
  qualifyingBadgeKeys,
  soloXpCeiling,
} from './recognition.scoring';

const ZERO: RecognitionSignals = {
  profileComplete: false,
  communitiesJoined: 0,
  audiencedCommunities: 0,
  personasPublished: 0,
  vouchCount: 0,
  connectionCount: 0,
  eventsAttended: 0,
  gatheringsAttended: 0,
  communityPosts: 0,
  engagedCommunityPosts: 0,
  endorsementCount: 0,
  eventsHosted: 0,
  eventsHeld: 0,
  tenureDays: 0,
  verified: false,
  gettingStartedStepsDone: 0,
  gettingStartedComplete: false,
  listingsSaved: 0,
  articlesSaved: 0,
  workProfileComplete: false,
  volunteerSessions: 0,
  piecesPublished: 0,
  directoryAnswers: 0,
  resourcesApproved: 0,
};

describe('recognition scoring', () => {
  it('scores zero signals as zero XP', () => {
    expect(scoreSignals(ZERO)).toBe(0);
  });

  it('scores a single completed profile at 50', () => {
    expect(scoreSignals({ ...ZERO, profileComplete: true })).toBe(50);
  });

  it('pays the posts, communities and events rules only on the gated units', () => {
    // The raw counts are a member's own volume: posts they wrote, rooms they
    // founded, their own RSVPs to their own gatherings. None of them pay.
    expect(
      scoreSignals({
        ...ZERO,
        communityPosts: 999,
        communitiesJoined: 999,
        eventsAttended: 999,
      }),
    ).toBe(0);
    // posts 20x15 + communities 3x40 + events 12x50 once a second person is
    // on the other end of each.
    expect(
      scoreSignals({
        ...ZERO,
        engagedCommunityPosts: 999,
        audiencedCommunities: 999,
        gatheringsAttended: 999,
      }),
    ).toBe(300 + 120 + 600);
  });

  it('caps a signal at its maximum units', () => {
    // connections: 25 XP each, cap 20 units => 500 max even at 999
    expect(scoreSignals({ ...ZERO, connectionCount: 999 })).toBe(500);
  });

  it('sums badge bonuses by rarity for badges somebody else was part of', () => {
    // first-gathering is common (40); first-steps is common (40)
    expect(badgeBonusXp(['first-gathering', 'first-steps'])).toBe(80);
    expect(badgeBonusXp(['does-not-exist'])).toBe(0);
  });

  it('pays no XP bonus for a badge a member earns entirely alone', () => {
    // Still awarded, still displayed, worth 0 XP: saving things, filling in
    // your own fields, and time served, which `tenure` already pays for
    // (PRD-05).
    for (const soloBadgeKey of [
      'local-scout',
      'well-read',
      'work-ready',
      'sustainer',
      'decade',
    ]) {
      expect(badgeBonusFor(soloBadgeKey)).toBe(0);
    }
    expect(badgeBonusXp(['local-scout', 'decade', 'first-gathering'])).toBe(40);
  });

  it('grants first-steps only when getting-started is complete', () => {
    expect(qualifyingBadgeKeys(ZERO)).not.toContain('first-steps');
    expect(
      qualifyingBadgeKeys({ ...ZERO, gettingStartedComplete: true }),
    ).toContain('first-steps');
  });

  it('grants two-homes on communities with an audience, never on the raw roster count', () => {
    // Founding three communities nobody joined is three roster rows and no
    // badge: `audiencedCommunities` is the unit (PRD-05).
    expect(
      qualifyingBadgeKeys({ ...ZERO, communitiesJoined: 3 }),
    ).not.toContain('two-homes');
    expect(
      qualifyingBadgeKeys({ ...ZERO, audiencedCommunities: 1 }),
    ).not.toContain('two-homes');
    expect(qualifyingBadgeKeys({ ...ZERO, audiencedCommunities: 2 })).toContain(
      'two-homes',
    );
  });

  it('grants local-scout at 3+ saved listings, well-read at 5+ saved articles', () => {
    expect(qualifyingBadgeKeys({ ...ZERO, listingsSaved: 2 })).not.toContain(
      'local-scout',
    );
    expect(qualifyingBadgeKeys({ ...ZERO, listingsSaved: 3 })).toContain(
      'local-scout',
    );
    expect(qualifyingBadgeKeys({ ...ZERO, articlesSaved: 4 })).not.toContain(
      'well-read',
    );
    expect(qualifyingBadgeKeys({ ...ZERO, articlesSaved: 5 })).toContain(
      'well-read',
    );
  });

  it('grants work-ready only once the work profile has skills and focus areas', () => {
    expect(qualifyingBadgeKeys(ZERO)).not.toContain('work-ready');
    expect(
      qualifyingBadgeKeys({ ...ZERO, workProfileComplete: true }),
    ).toContain('work-ready');
  });

  it('never auto-grants founding-member (no signal)', () => {
    const maxed: RecognitionSignals = {
      ...ZERO,
      gatheringsAttended: 999,
      connectionCount: 999,
      vouchCount: 999,
      engagedCommunityPosts: 999,
      tenureDays: 9999,
      eventsHosted: 999,
      eventsHeld: 999,
      gettingStartedComplete: true,
    };
    expect(qualifyingBadgeKeys(maxed)).not.toContain('founding-member');
  });
});

describe('badgeProgress', () => {
  it('reports {units, target} for a badge with a wired requirement', () => {
    expect(
      badgeProgress('three-company', { ...ZERO, gatheringsAttended: 2 }),
    ).toEqual({ units: 2, target: 3 });
  });

  it('clamps units to the target — raw signal values can exceed it', () => {
    expect(
      badgeProgress('three-company', { ...ZERO, gatheringsAttended: 999 }),
    ).toEqual({ units: 3, target: 3 });
  });

  it('returns undefined for a badge with no requirement (e.g. founding-member)', () => {
    expect(badgeProgress('founding-member', ZERO)).toBeUndefined();
  });

  it('agrees with isBadgeEarned/qualifyingBadgeKeys at the boundary', () => {
    const atTarget = { ...ZERO, gatheringsAttended: 3 };
    expect(badgeProgress('three-company', atTarget)).toEqual({
      units: 3,
      target: 3,
    });
    expect(isBadgeEarned('three-company', atTarget)).toBe(true);
    expect(qualifyingBadgeKeys(atTarget)).toContain('three-company');
  });
});

describe('the solo ceiling (PRD-05)', () => {
  /**
   * THE INVARIANT: nobody reaches invite quota alone.
   *
   * Level 4 is where XP starts buying extra monthly invitations
   * (`INVITE_QUOTA_BONUS_BY_LEVEL`), and on an invite-only platform an
   * invitation farm is a hole in the membrane. Every XP rule and badge
   * declares whether earning it costs the member somebody else; this holds
   * the sum of the ones that do not below the level-4 door.
   *
   * If a new rule breaks this, do not raise the number. Gate the rule.
   */
  it('keeps every solo path together below the level that buys invites', () => {
    expect(soloXpCeiling()).toBeLessThan(levelStartXp(4));
  });

  it('is 685 today: profile 50, personas 120, tenure 365, getting started 150', () => {
    expect(soloXpCeiling()).toBe(685);
    expect(levelStartXp(4)).toBe(950);
  });
});
