import { FriendMatchAnswers } from './go-together-questionnaire.catalog';
import {
  GO_TOGETHER_WEIGHTS,
  MatchCandidate,
  PairContext,
  computeInterestIdf,
  isPairFeasible,
  pairKey,
  scorePair,
} from './go-together-scoring';
import { buildGroupReasons, groupBand } from './go-together-reasons';

function answers(
  overrides: Partial<FriendMatchAnswers> = {},
): FriendMatchAnswers {
  return {
    values: {
      community: 4,
      creativity: 4,
      family: 3,
      fun: 5,
      career: 2,
      spirituality: 1,
    },
    humour: { h1: 'a', h2: 'a', h3: 'b', h4: 'a' },
    interests: ['boardGames', 'queerHistory', 'hiking'],
    music: ['pop', 'indie'],
    energy: { talker: 3, nightShape: 2, planner: 3 },
    intent: 'closeFriends',
    meetFrequency: 'fewTimesAMonth',
    languages: ['pt', 'en'],
    drinking: 'eitherWay',
    ageBracket: '25-34',
    agePreference: 'any',
    area: 'Arroios',
    ...overrides,
  };
}

function candidate(
  userId: string,
  overrides: Partial<FriendMatchAnswers> = {},
  extra: Partial<MatchCandidate> = {},
): MatchCandidate {
  return {
    userId,
    answers: answers(overrides),
    hostAnswers: {},
    lens: null,
    ...extra,
  };
}

const emptyContext: PairContext = {
  interestIdf: new Map(),
  blockedPairs: new Set(),
  avoidedPairs: new Set(),
  connectedPairs: new Set(),
};

describe('pairKey', () => {
  it('is order independent', () => {
    expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
  });
});

describe('isPairFeasible', () => {
  it('accepts two compatible members', () => {
    expect(isPairFeasible(candidate('a'), candidate('b'), emptyContext)).toBe(
      true,
    );
  });

  it('rejects a blocked pair and an avoided pair in either direction', () => {
    const blocked = {
      ...emptyContext,
      blockedPairs: new Set([pairKey('a', 'b')]),
    };
    const avoided = {
      ...emptyContext,
      avoidedPairs: new Set([pairKey('b', 'a')]),
    };
    expect(isPairFeasible(candidate('a'), candidate('b'), blocked)).toBe(false);
    expect(isPairFeasible(candidate('b'), candidate('a'), avoided)).toBe(false);
  });

  it('rejects different lenses and a lens next to no lens', () => {
    const trans = candidate('a', {}, { lens: 'transNonBinary' });
    expect(
      isPairFeasible(
        trans,
        candidate('b', {}, { lens: 'womenFemmes' }),
        emptyContext,
      ),
    ).toBe(false);
    expect(isPairFeasible(trans, candidate('b'), emptyContext)).toBe(false);
    expect(
      isPairFeasible(
        trans,
        candidate('b', {}, { lens: 'transNonBinary' }),
        emptyContext,
      ),
    ).toBe(true);
  });

  it('rejects members with no chat language in common', () => {
    expect(
      isPairFeasible(
        candidate('a', { languages: ['pt'] }),
        candidate('b', { languages: ['en'] }),
        emptyContext,
      ),
    ).toBe(false);
  });

  it('keeps a sober-group member apart from someone who will drink, and only them', () => {
    const sober = candidate('a', { drinking: 'soberGroup' });
    expect(
      isPairFeasible(
        sober,
        candidate('b', { drinking: 'willDrink' }),
        emptyContext,
      ),
    ).toBe(false);
    expect(
      isPairFeasible(
        sober,
        candidate('b', { drinking: 'eitherWay' }),
        emptyContext,
      ),
    ).toBe(true);
  });

  it('honours "similar age" from either side, one bracket apart at most', () => {
    const young = candidate('a', {
      ageBracket: '18-24',
      agePreference: 'similar',
    });
    expect(
      isPairFeasible(
        young,
        candidate('b', { ageBracket: '25-34' }),
        emptyContext,
      ),
    ).toBe(true);
    expect(
      isPairFeasible(
        young,
        candidate('b', { ageBracket: '35-44' }),
        emptyContext,
      ),
    ).toBe(false);
    expect(
      isPairFeasible(
        candidate('b', { ageBracket: '35-44' }),
        young,
        emptyContext,
      ),
    ).toBe(false);
  });
});

describe('scorePair', () => {
  it('scores identical answers near the top and stays within 0 to 1', () => {
    const { score } = scorePair(candidate('a'), candidate('b'), emptyContext);
    expect(score).toBeGreaterThan(0.9);
    expect(score).toBeLessThanOrEqual(1);
  });

  it('is symmetric', () => {
    const first = candidate('a');
    const second = candidate('b', {
      interests: ['cooking'],
      energy: { talker: 5, nightShape: 5, planner: 1 },
    });
    expect(scorePair(first, second, emptyContext).score).toBeCloseTo(
      scorePair(second, first, emptyContext).score,
    );
  });

  it("compares values after removing each person's own rating style", () => {
    const generous = candidate('a', {
      values: {
        community: 5,
        creativity: 5,
        family: 4,
        fun: 5,
        career: 3,
        spirituality: 2,
      },
    });
    const harsh = candidate('b', {
      values: {
        community: 4,
        creativity: 4,
        family: 3,
        fun: 4,
        career: 2,
        spirituality: 1,
      },
    });
    expect(
      scorePair(generous, harsh, emptyContext).components.values,
    ).toBeGreaterThan(0.9);
  });

  it('counts a shared rare interest above a shared common one', () => {
    const idf = computeInterestIdf([
      ['boardGames', 'pottery'],
      ['boardGames'],
      ['boardGames'],
      ['boardGames', 'pottery'],
    ]);
    const context = { ...emptyContext, interestIdf: idf };
    const rare = scorePair(
      candidate('a', { interests: ['pottery', 'hiking'] }),
      candidate('b', { interests: ['pottery', 'cooking'] }),
      context,
    );
    const common = scorePair(
      candidate('a', { interests: ['boardGames', 'hiking'] }),
      candidate('b', { interests: ['boardGames', 'cooking'] }),
      context,
    );
    expect(rare.components.interests).toBeGreaterThan(
      common.components.interests,
    );
  });

  it('treats an unanswered area as neutral', () => {
    const { components } = scorePair(
      candidate('a', { area: null }),
      candidate('b'),
      emptyContext,
    );
    expect(components.ageArea).toBeCloseTo(0.75);
  });

  it('never counts "elsewhere" as a shared area', () => {
    const { components } = scorePair(
      candidate('a', { area: 'elsewhere' }),
      candidate('b', { area: 'elsewhere' }),
      emptyContext,
    );
    expect(components.ageArea).toBeCloseTo(0.5);
  });

  it('adds the host bonus per shared answer and clamps at 1', () => {
    const first = candidate('a', {}, { hostAnswers: { q1: 'o1', q2: 'o2' } });
    const second = candidate('b', {}, { hostAnswers: { q1: 'o1', q2: 'o2' } });
    const result = scorePair(first, second, emptyContext);
    expect(result.components.hostBonus).toBeCloseTo(0.1);
    expect(result.score).toBeLessThanOrEqual(1);
  });

  it('weights sum to 1', () => {
    const total = Object.values(GO_TOGETHER_WEIGHTS).reduce(
      (sum, weight) => sum + weight,
      0,
    );
    expect(total).toBeCloseTo(1);
  });
});

describe('groupBand', () => {
  it('splits on the strong-fit threshold', () => {
    expect(groupBand(0.7)).toBe('strong');
    expect(groupBand(0.5)).toBe('good');
  });
});

describe('buildGroupReasons', () => {
  const members = [
    candidate(
      'a',
      { interests: ['pottery', 'hiking'], music: ['fado'], area: 'Arroios' },
      { hostAnswers: { q1: 'o2' } },
    ),
    candidate(
      'b',
      { interests: ['pottery', 'cooking'], music: ['fado'], area: 'Arroios' },
      { hostAnswers: { q1: 'o2' } },
    ),
    candidate(
      'c',
      { interests: ['pottery'], music: ['pop'], area: 'Anjos' },
      { hostAnswers: { q1: 'o2' } },
    ),
  ];

  it('returns at most three reasons, interests first', () => {
    const reasons = buildGroupReasons(members, new Map(), []);
    expect(reasons.length).toBeLessThanOrEqual(3);
    expect(reasons[0]).toEqual({
      kind: 'interests',
      tagIds: ['pottery'],
      count: 3,
      total: 3,
    });
    expect(reasons[1]).toEqual({
      kind: 'music',
      tagIds: ['fado'],
      count: 2,
      total: 3,
    });
  });

  it('never draws on values, humour, dealbreakers or the lens', () => {
    const reasons = buildGroupReasons(members, new Map(), []);
    const kinds = reasons.map((reason) => reason.kind);
    expect(
      kinds.every((kind) =>
        ['interests', 'music', 'energy', 'area', 'hostQuestion'].includes(kind),
      ),
    ).toBe(true);
  });

  it('uses a host question only when everyone gave the same answer', () => {
    const questions = [
      {
        id: 'q1',
        prompt: 'Favourite era?',
        options: [
          { id: 'o1', label: 'Erotica' },
          { id: 'o2', label: 'Confessions' },
        ],
      },
    ];
    const onlyHost = buildGroupReasons(
      members.map((member) => ({
        ...member,
        answers: {
          ...member.answers,
          interests: [],
          music: [],
          area: null,
          energy: { talker: 1, nightShape: 1, planner: 1 },
        },
      })),
      new Map(),
      questions,
    );
    expect(onlyHost).toContainEqual({
      kind: 'hostQuestion',
      questionId: 'q1',
      optionId: 'o2',
      prompt: 'Favourite era?',
      optionLabel: 'Confessions',
    });
  });
});
