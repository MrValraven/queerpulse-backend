import {
  parseFriendMatchAnswers,
  parseHostAnswers,
  parseHostQuestions,
} from './go-together-answers';

const valid = {
  values: {
    community: 4,
    creativity: 4,
    family: 3,
    fun: 5,
    career: 2,
    spirituality: 1,
  },
  humour: { h1: 'a', h2: 'b', h3: 'a', h4: 'b' },
  interests: ['boardGames', 'queerHistory'],
  music: ['fado'],
  energy: { talker: 3, nightShape: 2, planner: 4 },
  intent: 'both',
  meetFrequency: 'monthly',
  languages: ['pt'],
  drinking: 'soberGroup',
  ageBracket: '25-34',
  agePreference: 'similar',
  area: 'Arroios',
};

describe('parseFriendMatchAnswers', () => {
  it('accepts a complete answer set', () => {
    const result = parseFriendMatchAnswers(valid);
    expect(result.ok).toBe(true);
  });

  it('accepts a missing area as null', () => {
    const { area: _area, ...withoutArea } = valid;
    const result = parseFriendMatchAnswers(withoutArea);
    expect(result).toEqual(expect.objectContaining({ ok: true }));
    if (result.ok) expect(result.value.area).toBeNull();
  });

  it('reports every problem at once', () => {
    const result = parseFriendMatchAnswers({
      ...valid,
      values: { ...valid.values, fun: 9 },
      intent: 'x',
      languages: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual(
        expect.arrayContaining([
          'values.fun must be 1 to 5',
          'intent is invalid',
          'languages needs at least one language',
        ]),
      );
    }
  });

  it('rejects unknown tags and too many picks', () => {
    const tooMany = parseFriendMatchAnswers({
      ...valid,
      interests: [
        'boardGames',
        'cooking',
        'hiking',
        'yoga',
        'tarot',
        'pets',
        'plants',
        'cinema',
        'theatre',
      ],
    });
    const unknown = parseFriendMatchAnswers({ ...valid, music: ['polka'] });
    expect(tooMany.ok).toBe(false);
    expect(unknown.ok).toBe(false);
  });

  it('rejects a non-object', () => {
    expect(parseFriendMatchAnswers('hello')).toEqual({
      ok: false,
      errors: ['answers must be an object'],
    });
  });
});

describe('parseHostQuestions', () => {
  it('assigns server ids and trims text', () => {
    const result = parseHostQuestions([
      { prompt: '  Favourite era? ', options: ['Erotica', ' Confessions '] },
    ]);
    expect(result).toEqual({
      ok: true,
      value: [
        {
          id: 'q1',
          prompt: 'Favourite era?',
          options: [
            { id: 'o1', label: 'Erotica' },
            { id: 'o2', label: 'Confessions' },
          ],
        },
      ],
    });
  });

  it('rejects more than two questions and too few options', () => {
    expect(
      parseHostQuestions([
        { prompt: 'a', options: ['x', 'y'] },
        { prompt: 'b', options: ['x', 'y'] },
        { prompt: 'c', options: ['x', 'y'] },
      ]).ok,
    ).toBe(false);
    expect(parseHostQuestions([{ prompt: 'a', options: ['x'] }]).ok).toBe(
      false,
    );
  });
});

describe('parseHostAnswers', () => {
  const questions = [
    {
      id: 'q1',
      prompt: 'Era?',
      options: [
        { id: 'o1', label: 'A' },
        { id: 'o2', label: 'B' },
      ],
    },
  ];

  it('requires an answer from the options for every question', () => {
    expect(parseHostAnswers(questions, { q1: 'o2' })).toEqual({
      ok: true,
      value: { q1: 'o2' },
    });
    expect(parseHostAnswers(questions, { q1: 'o9' }).ok).toBe(false);
    expect(parseHostAnswers(questions, {}).ok).toBe(false);
  });

  it('accepts an empty body when the gathering has no questions', () => {
    expect(parseHostAnswers([], undefined)).toEqual({ ok: true, value: {} });
  });
});
