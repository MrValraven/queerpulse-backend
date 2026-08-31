import { PERK_CATALOG } from './recognition.catalog';
import {
  BADGE_REQUIREMENTS,
  type RecognitionSignals,
} from './recognition.scoring';
import {
  buildBadges,
  buildLevelLadder,
  buildPerks,
  buildRecognition,
  buildXpLedger,
  computeLevel,
} from './recognition-response';

// `founding-member` is the only `BADGE_CATALOG` entry with no
// `BADGE_REQUIREMENTS` wiring, so it's excluded from `locked`/`discoverCount`
// (COM-14) — this is the count of badges a member can actually still earn.
const OBTAINABLE_BADGE_COUNT = Object.keys(BADGE_REQUIREMENTS).length;

describe('computeLevel', () => {
  it('0 XP → Level 1 Newcomer, 0% progress, xpToNext = the full span', () => {
    expect(computeLevel(0)).toEqual({
      level: 1,
      name: 'Newcomer',
      xp: 0,
      xpMax: 200,
      percent: 0,
      xpToNext: 200,
      nextName: 'Explorer',
    });
  });

  it('mid-level XP computes percent/xpToNext relative to that level span', () => {
    expect(computeLevel(150)).toEqual({
      level: 1,
      name: 'Newcomer',
      xp: 150,
      xpMax: 200,
      percent: 75,
      xpToNext: 50,
      nextName: 'Explorer',
    });
  });

  it('exactly at a level boundary rolls over to the next level at 0 progress', () => {
    expect(computeLevel(200)).toEqual({
      level: 2,
      name: 'Explorer',
      xp: 0,
      xpMax: 300,
      percent: 0,
      xpToNext: 300,
      nextName: 'Regular',
    });
  });

  it('negative XP is clamped to 0', () => {
    expect(computeLevel(-50)).toEqual(computeLevel(0));
  });

  it('XP at or beyond the top of the ladder caps at the max level (Pillar), 100%, no next', () => {
    // Sum of every finite span in LEVEL_LADDER_DEF (200+300+450+650+900+1200).
    const totalSpans = 3700;
    expect(computeLevel(totalSpans)).toEqual({
      level: 7,
      name: 'Pillar',
      xp: 0,
      xpMax: 0,
      percent: 100,
      xpToNext: 0,
      nextName: null,
    });
    // Overshooting further stays pinned at the max level.
    expect(computeLevel(totalSpans + 10_000)).toEqual(computeLevel(totalSpans));
  });
});

describe('buildLevelLadder', () => {
  it('marks levels below current as done, the current as current, above as locked', () => {
    const ladder = buildLevelLadder(4);
    expect(ladder).toHaveLength(7);
    expect(ladder.slice(0, 3).every((r) => r.state === 'done')).toBe(true);
    expect(ladder[3]).toMatchObject({
      num: 4,
      name: 'Familiar',
      state: 'current',
    });
    expect(ladder.slice(4).every((r) => r.state === 'locked')).toBe(true);
  });
});

describe('buildBadges', () => {
  it('splits the catalogue into earned/locked based on which keys are awarded', () => {
    const result = buildBadges([
      { badgeKey: 'first-gathering', context: 'Pride Brunch · Jun 2025' },
    ]);
    expect(result.earnedCount).toBe(1);
    expect(result.discoverCount).toBe(OBTAINABLE_BADGE_COUNT - 1);
    expect(result.earned).toEqual([
      {
        key: 'first-gathering',
        cat: 'Attendance',
        name: 'First Gathering',
        context: 'Pride Brunch · Jun 2025',
        rarity: 'common',
        tint: 'jade',
        xpReward: 40,
        verifiedBy: 'auto',
      },
    ]);
    expect(result.locked).toHaveLength(OBTAINABLE_BADGE_COUNT - 1);
    expect(result.locked.some((b) => b.key === 'first-gathering')).toBe(false);
  });

  it('founding-member has no BADGE_REQUIREMENTS wiring, so it never appears in the locked grid (COM-14); every badge that does appear is honestly verifiedBy "auto"', () => {
    const result = buildBadges([]);
    expect(result.locked.some((b) => b.key === 'founding-member')).toBe(false);
    expect(result.locked.every((b) => b.verifiedBy === 'auto')).toBe(true);
    const decade = result.locked.find((b) => b.key === 'decade');
    expect(decade?.verifiedBy).toBe('auto');
  });

  it('xpReward is derived from rarity for every badge', () => {
    const result = buildBadges([]);
    const legendary = result.locked.find((b) => b.key === 'event-host');
    expect(legendary?.xpReward).toBe(150);
    const common = result.locked.find((b) => b.key === 'first-gathering');
    expect(common?.xpReward).toBe(40);
  });

  it('the seasonal band is empty until a seasonal badge gets a real BADGE_REQUIREMENTS signal (COM-14) — none has one today', () => {
    const result = buildBadges([]);
    expect(result.seasonal).toEqual([]);
  });

  describe('locked-badge progress', () => {
    const ZERO_SIGNALS: RecognitionSignals = {
      profileComplete: false,
      communitiesJoined: 0,
      audiencedCommunities: 0,
      personasPublished: 0,
      vouchCount: 0,
      connectionCount: 0,
      eventsAttended: 2,
      // The gated unit the attendance badges read (PRD-05); the raw
      // `eventsAttended` beside it is a readout only.
      gatheringsAttended: 2,
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

    it('is populated when signals are passed (owner view)', () => {
      const result = buildBadges([], ZERO_SIGNALS);
      const threeCompany = result.locked.find((b) => b.key === 'three-company');
      expect(threeCompany?.progress).toEqual({ units: 2, target: 3 });
    });

    it('is omitted entirely for a non-owner view (signals = null)', () => {
      const result = buildBadges([], null);
      const threeCompany = result.locked.find((b) => b.key === 'three-company');
      expect(threeCompany?.progress).toBeUndefined();
    });
  });

  it('falls back to the catalogue earnedContext when no per-award context was recorded', () => {
    const result = buildBadges([
      { badgeKey: 'first-gathering', context: null },
    ]);
    expect(result.earned[0]!.context).toBe('Attended a QueerPulse gathering');
  });

  it('locked badges surface the catalogue lockedContext (how to earn it)', () => {
    const result = buildBadges([]);
    expect(result.earnedCount).toBe(0);
    expect(result.discoverCount).toBe(OBTAINABLE_BADGE_COUNT);
    const decade = result.locked.find((b) => b.key === 'decade');
    expect(decade?.context).toBe('Be a member for 1 year');
  });

  it('ignores an awarded key that no longer exists in the catalogue', () => {
    const result = buildBadges([
      { badgeKey: 'not-a-real-badge', context: '???' },
    ]);
    expect(result.earnedCount).toBe(0);
    expect(result.discoverCount).toBe(OBTAINABLE_BADGE_COUNT);
  });
});

describe('buildPerks', () => {
  it('at Level 1: vouch-access is already available (no level gate — COM-15), everything else is locked by level', () => {
    const result = buildPerks(1, 50, []);
    // `vouch-access` has `unlockLevel: 1` — any active member can vouch from
    // day one, so it's never shown as locked behind a level (COM-15).
    expect(result.availableCount).toBe(1);
    const labels = result.groups.map((g) => g.label);
    const available = result.groups.find(
      (g) => g.label === 'Available to claim',
    );
    expect(available?.perks).toEqual([
      expect.objectContaining({ title: 'Vouch access', state: 'available' }),
    ]);
    expect(labels.some((l) => l.startsWith('Coming at Level 4'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Coming at Level 5'))).toBe(true);
    // Locked perks carry a lock footer, not the catalogue's available footer.
    const lockedGroup = result.groups.find((g) =>
      g.label.startsWith('Coming at Level 4'),
    );
    expect(lockedGroup?.perks[0]).toMatchObject({
      state: 'locked',
      footer: { type: 'lock', label: 'Unlocks at Level 4 · Familiar' },
    });
  });

  it('at Level 4: everything unlockable at or below 4 becomes available', () => {
    const result = buildPerks(4, 700, []);
    const perksAtOrBelow4 = PERK_CATALOG.filter(
      (p) => p.unlockLevel <= 4,
    ).length;
    expect(result.availableCount).toBe(perksAtOrBelow4);
    const available = result.groups.find(
      (g) => g.label === 'Available to claim',
    );
    expect(available?.perks).toHaveLength(perksAtOrBelow4);
    expect(available?.perks.every((p) => p.state === 'available')).toBe(true);
    // Only Level 5 perks remain locked.
    expect(
      result.groups.some((g) => g.label.startsWith('Coming at Level 5')),
    ).toBe(true);
  });

  it('a claimed perk moves to "Already claimed" with a claimed-date footer, regardless of level', () => {
    const claimedAt = new Date('2026-02-14T00:00:00.000Z');
    const result = buildPerks(5, 1600, [
      { perkKey: 'vouch-access', claimedAt },
    ]);
    const claimedGroup = result.groups.find(
      (g) => g.label === 'Already claimed',
    );
    expect(claimedGroup?.perks).toEqual([
      expect.objectContaining({
        title: 'Vouch access',
        state: 'claimed',
        footer: { type: 'claimed', date: claimedAt.toISOString() },
      }),
    ]);
    // Claimed perks are excluded from the available count/group.
    const available = result.groups.find(
      (g) => g.label === 'Available to claim',
    );
    expect(available?.perks.some((p) => p.title === 'Vouch access')).toBe(
      false,
    );
  });

  it('the perk ladder reports xpToNext-style "N XP away" for locked levels and Done/Current for the rest', () => {
    const result = buildPerks(2, 250, []);
    const row1 = result.ladder.find((r) => r.num === 1)!;
    const row2 = result.ladder.find((r) => r.num === 2)!;
    const row3 = result.ladder.find((r) => r.num === 3)!;
    expect(row1.state).toBe('achieved');
    expect(row1.status).toBe('Done');
    expect(row2.state).toBe('current');
    expect(row2.status).toBe('Current');
    expect(row3.state).toBe('locked');
    // Level 3 starts at 200 + 300 = 500 cumulative XP; caller has 250.
    expect(row3.status).toBe('250 XP away');
  });
});

describe('buildRecognition', () => {
  it('assembles level + ladder + badges + perks into one RecognitionDTO', () => {
    // Cumulative level starts: L1=0, L2=200, L3=500, L4=950 — 1000 XP lands
    // just inside Level 4 (Familiar).
    const dto = buildRecognition(
      1000,
      [{ badgeKey: 'first-gathering', context: 'Pride Brunch' }],
      [],
    );
    expect(dto.level.level).toBe(4);
    expect(dto.level.name).toBe('Familiar');
    expect(dto.levelLadder).toHaveLength(7);
    expect(dto.badges.earnedCount).toBe(1);
    expect(dto.badges.discoverCount).toBe(OBTAINABLE_BADGE_COUNT - 1);
    expect(dto.perks.ladder).toHaveLength(7);
    expect(Array.isArray(dto.perks.groups)).toBe(true);
    // No signals passed => xpLedger is owner-gated closed, same as xpBreakdown.
    expect(dto.xpLedger).toEqual([]);
  });
});

describe('buildXpLedger', () => {
  it('maps stored rows to the frontend DTO, ISO-stamping createdAt', () => {
    const createdAt = new Date('2026-06-19T00:00:00.000Z');
    const rows = buildXpLedger([
      { description: 'Badge earned: Vouch', xp: 80, reason: null, createdAt },
      {
        description: 'Adjustment',
        xp: -20,
        reason: 'Duplicate entry removed.',
        createdAt,
      },
    ]);
    expect(rows).toEqual([
      {
        createdAt: '2026-06-19T00:00:00.000Z',
        description: 'Badge earned: Vouch',
        xp: 80,
        reason: undefined,
      },
      {
        createdAt: '2026-06-19T00:00:00.000Z',
        description: 'Adjustment',
        xp: -20,
        reason: 'Duplicate entry removed.',
      },
    ]);
  });
});
