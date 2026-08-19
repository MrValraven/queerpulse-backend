import {
  RecognitionSignals,
  badgeProgress,
  scoreSignals,
  badgeBonusXp,
  isBadgeEarned,
  qualifyingBadgeKeys,
} from './recognition.scoring';

const ZERO: RecognitionSignals = {
  profileComplete: false,
  communitiesJoined: 0,
  personasPublished: 0,
  vouchCount: 0,
  connectionCount: 0,
  eventsAttended: 0,
  communityPosts: 0,
  endorsementCount: 0,
  workshopsTaught: 0,
  tenureDays: 0,
  verified: false,
  gettingStartedStepsDone: 0,
  gettingStartedComplete: false,
  listingsSaved: 0,
  articlesSaved: 0,
  workProfileComplete: false,
};

describe('recognition scoring', () => {
  it('scores zero signals as zero XP', () => {
    expect(scoreSignals(ZERO)).toBe(0);
  });

  it('scores a single completed profile at 50', () => {
    expect(scoreSignals({ ...ZERO, profileComplete: true })).toBe(50);
  });

  it('caps a signal at its maximum units', () => {
    // connections: 25 XP each, cap 20 units => 500 max even at 999
    expect(scoreSignals({ ...ZERO, connectionCount: 999 })).toBe(500);
  });

  it('sums badge bonuses by rarity', () => {
    // first-gathering is common (40); first-steps is common (40)
    expect(badgeBonusXp(['first-gathering', 'first-steps'])).toBe(80);
    expect(badgeBonusXp(['does-not-exist'])).toBe(0);
  });

  it('grants first-steps only when getting-started is complete', () => {
    expect(qualifyingBadgeKeys(ZERO)).not.toContain('first-steps');
    expect(
      qualifyingBadgeKeys({ ...ZERO, gettingStartedComplete: true }),
    ).toContain('first-steps');
  });

  it('grants two-homes only once a member has joined 2+ communities', () => {
    expect(
      qualifyingBadgeKeys({ ...ZERO, communitiesJoined: 1 }),
    ).not.toContain('two-homes');
    expect(qualifyingBadgeKeys({ ...ZERO, communitiesJoined: 2 })).toContain(
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
      eventsAttended: 999,
      connectionCount: 999,
      vouchCount: 999,
      communityPosts: 999,
      tenureDays: 9999,
      workshopsTaught: 999,
      gettingStartedComplete: true,
    };
    expect(qualifyingBadgeKeys(maxed)).not.toContain('founding-member');
  });
});

describe('badgeProgress', () => {
  it('reports {units, target} for a badge with a wired requirement', () => {
    expect(
      badgeProgress('three-company', { ...ZERO, eventsAttended: 2 }),
    ).toEqual({ units: 2, target: 3 });
  });

  it('clamps units to the target — raw signal values can exceed it', () => {
    expect(
      badgeProgress('three-company', { ...ZERO, eventsAttended: 999 }),
    ).toEqual({ units: 3, target: 3 });
  });

  it('returns undefined for a badge with no requirement (e.g. founding-member)', () => {
    expect(badgeProgress('founding-member', ZERO)).toBeUndefined();
  });

  it('agrees with isBadgeEarned/qualifyingBadgeKeys at the boundary', () => {
    const atTarget = { ...ZERO, eventsAttended: 3 };
    expect(badgeProgress('three-company', atTarget)).toEqual({
      units: 3,
      target: 3,
    });
    expect(isBadgeEarned('three-company', atTarget)).toBe(true);
    expect(qualifyingBadgeKeys(atTarget)).toContain('three-company');
  });
});
