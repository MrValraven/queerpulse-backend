import {
  groupMinimumAffinity,
  hasGatheringStarted,
  isGatheringUpcoming,
  isPastBlockMoveGrace,
} from './go-together-formation.helpers';
import { MatchGraph, MatchUnit } from './go-together-grouping';

/**
 * Four people: 0 and 1 score each other 1.0, each of them scores 2 and 3 at
 * 0.3, and 2 and 3 score each other 0.9.
 */
function graphWithClosePair(): MatchGraph {
  const isCloseFriend = (person: number): boolean => person <= 1;
  return {
    size: 4,
    score: (first, second) => {
      if (isCloseFriend(first) && isCloseFriend(second)) return 1;
      if (!isCloseFriend(first) && !isCloseFriend(second)) return 0.9;
      return 0.3;
    },
    feasible: () => true,
    isTalker: () => true,
    connected: () => false,
  };
}

describe('groupMinimumAffinity', () => {
  it("leaves a pair's score to each other out, like the solver", () => {
    const units: MatchUnit[] = [
      { id: 'pair', members: [0, 1] },
      { id: 'solo-2', members: [2] },
      { id: 'solo-3', members: [3] },
    ];

    // Person 0 counts only 2 and 3: (0.3 + 0.3) / 2.
    expect(
      groupMinimumAffinity(graphWithClosePair(), units, [0, 1, 2, 3]),
    ).toBeCloseTo(0.3);
  });

  it('counts every other member when the same two people are solos', () => {
    const units: MatchUnit[] = [
      { id: 'solo-0', members: [0] },
      { id: 'solo-1', members: [1] },
      { id: 'solo-2', members: [2] },
      { id: 'solo-3', members: [3] },
    ];

    // Person 2 is now the worst off: (0.3 + 0.3 + 0.9) / 3.
    expect(
      groupMinimumAffinity(graphWithClosePair(), units, [0, 1, 2, 3]),
    ).toBeCloseTo(0.5);
  });

  it('gives 0 to a group that is only one unit', () => {
    const units: MatchUnit[] = [{ id: 'pair', members: [0, 1] }];

    expect(groupMinimumAffinity(graphWithClosePair(), units, [0, 1])).toBe(0);
  });
});

describe('hasGatheringStarted', () => {
  const startAt = new Date('2026-10-10T20:00:00Z');

  it('is false before the start', () => {
    expect(
      hasGatheringStarted({ startAt }, new Date('2026-10-10T19:59:59Z')),
    ).toBe(false);
  });

  it('is true from the start itself onward', () => {
    expect(hasGatheringStarted({ startAt }, startAt)).toBe(true);
    expect(
      hasGatheringStarted({ startAt }, new Date('2026-10-10T21:00:00Z')),
    ).toBe(true);
  });

  it('treats a gathering that can no longer be read as started', () => {
    expect(hasGatheringStarted(null, startAt)).toBe(true);
  });

  it('is always the negation of isGatheringUpcoming', () => {
    const before = new Date('2026-10-10T19:00:00Z');
    expect(isGatheringUpcoming({ startAt }, before)).toBe(true);
    expect(isGatheringUpcoming({ startAt }, startAt)).toBe(false);
    expect(isGatheringUpcoming(null, before)).toBe(false);
  });
});

describe('isPastBlockMoveGrace', () => {
  const startAt = new Date('2026-10-10T20:00:00Z');

  it('is false before the start and up to twelve hours after it', () => {
    expect(
      isPastBlockMoveGrace({ startAt }, new Date('2026-10-10T19:00:00Z')),
    ).toBe(false);
    expect(
      isPastBlockMoveGrace({ startAt }, new Date('2026-10-11T07:59:59Z')),
    ).toBe(false);
  });

  it('is true from twelve hours after the start', () => {
    expect(
      isPastBlockMoveGrace({ startAt }, new Date('2026-10-11T08:00:00Z')),
    ).toBe(true);
  });

  it('is false for a gathering that can no longer be read', () => {
    expect(isPastBlockMoveGrace(null, startAt)).toBe(false);
  });
});
