import { BADGE_CATALOG, PERK_CATALOG } from './recognition.catalog';
import {
  buildBadges,
  buildLevelLadder,
  buildPerks,
  buildRecognition,
  computeLevel,
} from './recognition-response';

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
    expect(result.discoverCount).toBe(BADGE_CATALOG.length - 1);
    expect(result.earned).toEqual([
      {
        key: 'first-gathering',
        cat: 'Attendance',
        name: 'First Gathering',
        context: 'Pride Brunch · Jun 2025',
        rarity: 'common',
        tint: 'jade',
      },
    ]);
    expect(result.locked).toHaveLength(BADGE_CATALOG.length - 1);
    expect(result.locked.some((b) => b.key === 'first-gathering')).toBe(false);
  });

  it('falls back to the catalogue earnedContext when no per-award context was recorded', () => {
    const result = buildBadges([
      { badgeKey: 'first-gathering', context: null },
    ]);
    expect(result.earned[0].context).toBe('Attended a QueerPulse gathering');
  });

  it('locked badges surface the catalogue lockedContext (how to earn it)', () => {
    const result = buildBadges([]);
    expect(result.earnedCount).toBe(0);
    expect(result.discoverCount).toBe(BADGE_CATALOG.length);
    const decade = result.locked.find((b) => b.key === 'decade');
    expect(decade?.context).toBe('Attend 10 gatherings');
  });

  it('ignores an awarded key that no longer exists in the catalogue', () => {
    const result = buildBadges([
      { badgeKey: 'not-a-real-badge', context: '???' },
    ]);
    expect(result.earnedCount).toBe(0);
    expect(result.discoverCount).toBe(BADGE_CATALOG.length);
  });
});

describe('buildPerks', () => {
  it('below every unlock level: nothing available, all perks bucketed as locked by level', () => {
    const result = buildPerks(1, 50, []);
    expect(result.availableCount).toBe(0);
    const labels = result.groups.map((g) => g.label);
    expect(labels).not.toContain('Available to claim');
    expect(labels.some((l) => l.startsWith('Coming at Level 3'))).toBe(true);
    expect(labels.some((l) => l.startsWith('Coming at Level 5'))).toBe(true);
    // Locked perks carry a lock footer, not the catalogue's available footer.
    const lockedGroup = result.groups.find((g) =>
      g.label.startsWith('Coming at Level 3'),
    );
    expect(lockedGroup?.perks[0]).toMatchObject({
      state: 'locked',
      footer: { type: 'lock', label: 'Unlocks at Level 3 · Regular' },
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
    expect(dto.badges.discoverCount).toBe(BADGE_CATALOG.length - 1);
    expect(dto.perks.ladder).toHaveLength(7);
    expect(Array.isArray(dto.perks.groups)).toBe(true);
  });
});
