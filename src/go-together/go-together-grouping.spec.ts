import {
  EXACT_POOL_LIMIT,
  MatchGraph,
  MatchUnit,
  createRandom,
  formGroups,
  insertIntoBestGroup,
  planGroupSizes,
  seedFrom,
} from './go-together-grouping';

/** A graph from a dense score matrix; `blocked` pairs are infeasible. */
function graphFrom(
  scores: number[][],
  blocked: [number, number][] = [],
  talkers: number[] = [],
  connected: [number, number][] = [],
): MatchGraph {
  const key = (first: number, second: number): string =>
    first < second ? `${first}:${second}` : `${second}:${first}`;
  const blockedSet = new Set(
    blocked.map(([first, second]) => key(first, second)),
  );
  const connectedSet = new Set(
    connected.map(([first, second]) => key(first, second)),
  );
  return {
    size: scores.length,
    score: (first, second) => scores[first]?.[second] ?? 0,
    feasible: (first, second) => !blockedSet.has(key(first, second)),
    isTalker: (person) => talkers.includes(person),
    connected: (first, second) => connectedSet.has(key(first, second)),
  };
}

function randomScores(size: number, seed: number): number[][] {
  const random = createRandom(seed);
  const scores = Array.from({ length: size }, () =>
    new Array<number>(size).fill(0),
  );
  for (let first = 0; first < size; first += 1) {
    for (let second = first + 1; second < size; second += 1) {
      const value = 0.3 + 0.6 * random();
      scores[first]![second] = value;
      scores[second]![first] = value;
    }
  }
  return scores;
}

function solos(count: number): MatchUnit[] {
  return Array.from({ length: count }, (_, person) => ({
    id: `u${person}`,
    members: [person],
  }));
}

function peopleIn(units: MatchUnit[], group: number[]): number[] {
  return group.flatMap((unitIndex) => units[unitIndex]!.members);
}

describe('planGroupSizes', () => {
  it.each([
    [0, []],
    [2, []],
    [3, [3]],
    [4, [4]],
    [5, [5]],
    [6, [6]],
    [7, [4, 3]],
    [8, [4, 4]],
    [9, [5, 4]],
    [10, [5, 5]],
    [11, [6, 5]],
    [12, [4, 4, 4]],
    [13, [5, 4, 4]],
    [23, [5, 5, 5, 4, 4]],
  ])('plans %i people as %j', (people, expected) => {
    expect(planGroupSizes(people)).toEqual(expected);
  });

  it('uses only 4s and 5s from 12 people up', () => {
    for (let people = 12; people <= 200; people += 1) {
      const plan = planGroupSizes(people);
      expect(plan.reduce((sum, size) => sum + size, 0)).toBe(people);
      expect(plan.every((size) => size === 4 || size === 5)).toBe(true);
    }
  });
});

describe('formGroups', () => {
  it('groups nobody when fewer than 3 people opted in', () => {
    const units = solos(2);
    const result = formGroups(graphFrom(randomScores(2, 1)), units, {
      seed: 1,
      minAffinity: 0,
    });
    expect(result.groups).toEqual([]);
    expect(result.unmatchedUnits).toEqual([0, 1]);
  });

  it('never puts a blocked pair in the same group', () => {
    for (let seed = 1; seed <= 25; seed += 1) {
      const size = 8 + (seed % 20);
      const random = createRandom(seed);
      const blocked: [number, number][] = Array.from({ length: size }, () => [
        Math.floor(random() * size),
        Math.floor(random() * size),
      ]);
      const graph = graphFrom(randomScores(size, seed), blocked);
      const units = solos(size);
      const result = formGroups(graph, units, {
        seed,
        minAffinity: 0,
        iterationsPerRestart: 2000,
        restarts: 3,
      });
      for (const group of result.groups) {
        const people = peopleIn(units, group);
        for (const first of people) {
          for (const second of people) {
            if (first !== second)
              expect(graph.feasible(first, second)).toBe(true);
          }
        }
      }
    }
  });

  it('keeps pairs together and allows at most one multi-person unit per group', () => {
    const units: MatchUnit[] = [
      { id: 'p1', members: [0, 1] },
      { id: 'p2', members: [2, 3] },
      ...Array.from({ length: 10 }, (_, index) => ({
        id: `s${index}`,
        members: [index + 4],
      })),
    ];
    const result = formGroups(graphFrom(randomScores(14, 7)), units, {
      seed: 7,
      minAffinity: 0,
    });
    for (const group of result.groups) {
      const multi = group.filter(
        (unitIndex) => units[unitIndex]!.members.length > 1,
      );
      expect(multi.length).toBeLessThanOrEqual(1);
    }
    const pairGroup = result.groups.find((group) => group.includes(0));
    expect(pairGroup).toBeDefined();
  });

  it('only forms groups of allowed sizes', () => {
    for (let people = 3; people <= 60; people += 1) {
      const units = solos(people);
      const result = formGroups(
        graphFrom(randomScores(people, people)),
        units,
        {
          seed: people,
          minAffinity: 0,
          iterationsPerRestart: 1500,
          restarts: 2,
        },
      );
      const allowed = new Set([4, 5, ...planGroupSizes(people)]);
      for (const group of result.groups) {
        expect(allowed.has(peopleIn(units, group).length)).toBe(true);
      }
    }
  });

  it('is deterministic for the same inputs and seed', () => {
    const graph = graphFrom(randomScores(30, 3));
    const units = solos(30);
    const options = {
      seed: seedFrom('event-1:1'),
      minAffinity: 0.2,
      iterationsPerRestart: 3000,
      restarts: 4,
    };
    expect(formGroups(graph, units, options).groups).toEqual(
      formGroups(graph, units, options).groups,
    );
  });

  it('leaves a person below the affinity floor unmatched', () => {
    const scores = randomScores(9, 11);
    for (let other = 0; other < 9; other += 1) {
      if (other === 8) continue;
      scores[8]![other] = 0.05;
      scores[other]![8] = 0.05;
    }
    const units = solos(9);
    const result = formGroups(graphFrom(scores), units, {
      seed: 11,
      minAffinity: 0.35,
    });
    expect(result.unmatchedUnits).toContain(8);
    for (const value of result.affinity.values())
      expect(value).toBeGreaterThanOrEqual(0.35);
  });

  it('reports a unit blocked from everyone as unmatched', () => {
    const scores = randomScores(5, 42);
    const blocked: [number, number][] = [
      [4, 0],
      [4, 1],
      [4, 2],
      [4, 3],
    ];
    const units = solos(5);
    const result = formGroups(graphFrom(scores, blocked), units, {
      seed: 42,
      minAffinity: 0,
    });
    const groupedUnitIndexes = result.groups.flat();
    expect(groupedUnitIndexes).not.toContain(4);
    expect(result.unmatchedUnits).toContain(4);
    expect(
      [...groupedUnitIndexes, ...result.unmatchedUnits].sort(
        (first, second) => first - second,
      ),
    ).toEqual([0, 1, 2, 3, 4]);
  });

  it('accounts for every unit exactly once even when some units join no group', () => {
    for (let peopleCount = 3; peopleCount <= 40; peopleCount += 1) {
      const random = createRandom(peopleCount + 1000);
      const blockedPairCount = Math.max(1, Math.floor(peopleCount / 2));
      const blocked: [number, number][] = Array.from(
        { length: blockedPairCount },
        () => [
          Math.floor(random() * peopleCount),
          Math.floor(random() * peopleCount),
        ],
      );
      const graph = graphFrom(
        randomScores(peopleCount, peopleCount + 1000),
        blocked,
      );
      const units = solos(peopleCount);
      const result = formGroups(graph, units, {
        seed: peopleCount + 1000,
        minAffinity: 0,
        iterationsPerRestart: 1200,
        restarts: 2,
      });
      const accountedForUnitIndexes = [
        ...result.groups.flat(),
        ...result.unmatchedUnits,
      ].sort((first, second) => first - second);
      expect(accountedForUnitIndexes).toEqual(
        Array.from({ length: peopleCount }, (_, index) => index),
      );
    }
  });

  it('solves small pools exactly: the worst member beats a naive split', () => {
    // Two cliques of 4 with strong ties inside and weak ties across.
    const size = 8;
    const scores = Array.from({ length: size }, (_, first) =>
      Array.from({ length: size }, (_, second) =>
        Math.floor(first / 4) === Math.floor(second / 4) ? 0.9 : 0.2,
      ),
    );
    const units = solos(size).reverse();
    expect(size).toBeLessThanOrEqual(EXACT_POOL_LIMIT);
    const result = formGroups(graphFrom(scores), units, {
      seed: 5,
      minAffinity: 0,
    });
    expect(Math.min(...result.groupMinimumAffinity)).toBeCloseTo(0.9);
  });

  it('protects the worst-off member on larger pools', () => {
    const size = 40;
    const scores = randomScores(size, 21);
    const units = solos(size);
    const result = formGroups(graphFrom(scores), units, {
      seed: 21,
      minAffinity: 0,
    });
    // Baseline: people in index order, chunked by the plan.
    let cursor = 0;
    const naiveMinimum = Math.min(
      ...planGroupSizes(size).map((groupSize) => {
        const people = Array.from(
          { length: groupSize },
          (_, offset) => cursor + offset,
        );
        cursor += groupSize;
        return Math.min(
          ...people.map(
            (person) =>
              people
                .filter((other) => other !== person)
                .reduce((sum, other) => sum + scores[person]![other]!, 0) /
              (people.length - 1),
          ),
        );
      }),
    );
    expect(Math.min(...result.groupMinimumAffinity)).toBeGreaterThan(
      naiveMinimum,
    );
  });

  it('reports a hit time budget when the clock runs out', () => {
    let tick = 0;
    const result = formGroups(graphFrom(randomScores(30, 2)), solos(30), {
      seed: 2,
      minAffinity: 0,
      timeBudgetMs: 1,
      now: () => (tick += 10),
    });
    expect(result.hitTimeBudget).toBe(true);
  });
});

describe('insertIntoBestGroup', () => {
  it('picks the group where the joiner fits best and respects the size cap', () => {
    const scores = randomScores(10, 4);
    scores[9]![0] = scores[0]![9] = 0.95;
    scores[9]![1] = scores[1]![9] = 0.95;
    scores[9]![2] = scores[2]![9] = 0.95;
    scores[9]![3] = scores[3]![9] = 0.95;
    const graph = graphFrom(scores);
    const units = solos(10);
    const groups = [
      [0, 1, 2, 3],
      [4, 5, 6, 7, 8],
    ];
    expect(
      insertIntoBestGroup(graph, units, groups, 9, {
        maxSize: 5,
        minAffinity: 0,
      }),
    ).toBe(0);
    expect(
      insertIntoBestGroup(graph, units, [[4, 5, 6, 7, 8]], 9, {
        maxSize: 5,
        minAffinity: 0,
      }),
    ).toBeNull();
  });

  it('refuses a group holding someone the joiner blocked', () => {
    const graph = graphFrom(randomScores(6, 9), [[5, 0]]);
    expect(
      insertIntoBestGroup(graph, solos(6), [[0, 1, 2, 3]], 5, {
        maxSize: 5,
        minAffinity: 0,
      }),
    ).toBeNull();
  });
});
