import {
  RecognitionSignals,
  scoreSignals,
  badgeBonusXp,
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
