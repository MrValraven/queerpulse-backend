import { groupMinimumAffinity } from './go-together-formation.helpers';
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
