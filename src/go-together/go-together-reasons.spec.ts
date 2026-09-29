import type { FriendMatchAnswers } from './go-together-questionnaire.catalog';
import { buildGroupReasons } from './go-together-reasons';
import type { MatchCandidate } from './go-together-scoring';

function member(userId: string, hostAnswers: Record<string, string>) {
  const answers = {
    values: {
      community: 3,
      creativity: 3,
      family: 3,
      fun: 3,
      career: 3,
      spirituality: 3,
    },
    humour: {},
    interests: [],
    music: [],
    // A wide energy spread keeps the energy reason out of these cases.
    energy: { talker: 3, nightShape: 1, planner: 3 },
    intent: 'both',
    meetFrequency: 'monthly',
    languages: ['pt'],
    drinking: 'eitherWay',
    ageBracket: '25-34',
    agePreference: 'any',
    area: null,
  } as unknown as FriendMatchAnswers;
  return { userId, answers, hostAnswers, lens: null } as MatchCandidate;
}

function withNightShape(candidate: MatchCandidate, nightShape: number) {
  return {
    ...candidate,
    answers: {
      ...candidate.answers,
      energy: { ...candidate.answers.energy, nightShape },
    },
  } as MatchCandidate;
}

describe('buildGroupReasons host questions', () => {
  const question = {
    id: 'q1',
    prompt: 'Coffee or tea?',
    options: [
      { id: 'o1', label: 'Coffee' },
      { id: 'o2', label: 'Tea' },
    ],
  };

  it('names the option every member picked', () => {
    const members = [
      member('a', { q1: 'o2' }),
      withNightShape(member('b', { q1: 'o2' }), 5),
      member('c', { q1: 'o2' }),
    ];
    expect(buildGroupReasons(members, new Map(), [question])).toEqual([
      {
        kind: 'hostQuestion',
        questionId: 'q1',
        optionId: 'o2',
        prompt: 'Coffee or tea?',
        optionLabel: 'Tea',
      },
    ]);
  });

  it('skips an answer whose option the question no longer has', () => {
    const members = [
      member('a', { q1: 'o3' }),
      withNightShape(member('b', { q1: 'o3' }), 5),
      member('c', { q1: 'o3' }),
    ];
    expect(buildGroupReasons(members, new Map(), [question])).toEqual([]);
  });

  it('skips the question when one member has no current answer', () => {
    const members = [
      member('a', { q1: 'o2' }),
      withNightShape(member('b', { q1: 'o2' }), 5),
      member('c', {}),
    ];
    expect(buildGroupReasons(members, new Map(), [question])).toEqual([]);
  });
});
