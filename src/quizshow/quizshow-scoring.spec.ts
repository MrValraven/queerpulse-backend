import {
  closestNumberOutcomes,
  competitionRanks,
  type QuizAnswerScoringInput,
  scoreLieDetectorVotes,
  scorePartyVotes,
  scoreQuizAnswer,
  speedPoints,
  streakBonusFor,
  teamQuestionPoints,
} from './quizshow-scoring';

const BASE = 1000;
const LIMIT_MS = 20000;

function scoringInput(
  overrides: Partial<QuizAnswerScoringInput>,
): QuizAnswerScoringInput {
  return {
    type: 'multiple_choice',
    base: BASE,
    answerKey: { type: 'multiple_choice', correctIndex: 1 },
    payload: { type: 'multiple_choice', optionIndex: 1 },
    elapsedMs: 0,
    ownLimitMs: LIMIT_MS,
    isSpeedBonusOn: true,
    streakBefore: 0,
    isJokerActive: false,
    closestOutcome: null,
    ...overrides,
  };
}

const isJokerNeverActive = (): boolean => false;

describe('Pulse Live scoring', () => {
  it('scores the full base at zero elapsed and half at the limit', () => {
    expect(speedPoints(BASE, 0, LIMIT_MS, true)).toBe(1000);
    expect(speedPoints(BASE, 10000, LIMIT_MS, true)).toBe(750);
    expect(speedPoints(BASE, 20000, LIMIT_MS, true)).toBe(500);
    expect(speedPoints(BASE, 20400, LIMIT_MS, true)).toBe(500);
    expect(speedPoints(BASE, -50, LIMIT_MS, true)).toBe(1000);
  });

  it('gives every correct answer the base with the speed bonus off', () => {
    expect(speedPoints(BASE, 19000, LIMIT_MS, false)).toBe(1000);
  });

  it('measures an extra-time player against their own limit', () => {
    expect(speedPoints(BASE, 15000, 30000, true)).toBe(750);
  });

  it('caps the streak at 500', () => {
    expect(streakBonusFor(1)).toBe(100);
    expect(streakBonusFor(5)).toBe(500);
    expect(streakBonusFor(7)).toBe(500);
  });

  it('scores an order partial without speed and an exact order with it', () => {
    const answerKey = {
      type: 'order' as const,
      orderedIds: ['a', 'b', 'c', 'd'],
    };
    const partial = scoreQuizAnswer(
      scoringInput({
        type: 'order',
        answerKey,
        payload: { type: 'order', orderedIds: ['a', 'b', 'd', 'c'] },
        elapsedMs: 10000,
        streakBefore: 2,
      }),
    );
    expect(partial.pointsAwarded).toBe(500);
    expect(partial.isCorrect).toBe(false);
    expect(partial.streakAfter).toBe(0);
    expect(partial.correctPositions).toBe(2);

    const exact = scoreQuizAnswer(
      scoringInput({
        type: 'order',
        answerKey,
        payload: { type: 'order', orderedIds: ['a', 'b', 'c', 'd'] },
        elapsedMs: 10000,
        streakBefore: 2,
      }),
    );
    expect(exact.isCorrect).toBe(true);
    expect(exact.correctPositions).toBe(4);
    expect(exact.streakAfter).toBe(3);
    expect(exact.streakBonus).toBe(300);
    expect(exact.pointsAwarded).toBe(1050);
  });

  it('gives the closest players the base and the 10% band half', () => {
    const tiedOutcomes = closestNumberOutcomes(100, [
      { playerId: 'p95', value: 95 },
      { playerId: 'p105', value: 105 },
      { playerId: 'p120', value: 120 },
      { playerId: 'p89', value: 89 },
    ]);
    expect(tiedOutcomes.get('p95')).toBe('closest');
    expect(tiedOutcomes.get('p105')).toBe('closest');
    expect(tiedOutcomes.get('p120')).toBe('none');
    expect(tiedOutcomes.get('p89')).toBe('none');

    const bandOutcomes = closestNumberOutcomes(100, [
      { playerId: 'p98', value: 98 },
      { playerId: 'p91', value: 91 },
    ]);
    expect(bandOutcomes.get('p98')).toBe('closest');
    expect(bandOutcomes.get('p91')).toBe('band');

    const answerKey = { type: 'closest_number' as const, value: 100 };
    for (const elapsedMs of [0, 10000, 20000]) {
      const closestScore = scoreQuizAnswer(
        scoringInput({
          type: 'closest_number',
          answerKey,
          payload: { type: 'closest_number', value: 98 },
          elapsedMs,
          closestOutcome: 'closest',
        }),
      );
      expect(closestScore.isCorrect).toBe(true);
      expect(closestScore.pointsAwarded - closestScore.streakBonus).toBe(1000);

      const bandScore = scoreQuizAnswer(
        scoringInput({
          type: 'closest_number',
          answerKey,
          payload: { type: 'closest_number', value: 91 },
          elapsedMs,
          closestOutcome: 'band',
        }),
      );
      expect(bandScore.isCorrect).toBe(false);
      expect(bandScore.streakBonus).toBe(0);
      expect(bandScore.pointsAwarded).toBe(500);
    }
  });

  it('keeps a decimal tie fair', () => {
    const outcomes = closestNumberOutcomes(0.3, [
      { playerId: 'below', value: 0.2 },
      { playerId: 'above', value: 0.4 },
    ]);
    expect(outcomes.get('below')).toBe('closest');
    expect(outcomes.get('above')).toBe('closest');
  });

  it('counts an answer exactly at the band edge', () => {
    const outcomes = closestNumberOutcomes(2, [
      { playerId: 'nearest', value: 2.1 },
      { playerId: 'edgeAbove', value: 2.2 },
      { playerId: 'edgeBelow', value: 1.8 },
    ]);
    expect(outcomes.get('nearest')).toBe('closest');
    expect(outcomes.get('edgeAbove')).toBe('band');
    expect(outcomes.get('edgeBelow')).toBe('band');
  });

  it('scores an empty order key as wrong', () => {
    const score = scoreQuizAnswer(
      scoringInput({
        type: 'order',
        answerKey: { type: 'order', orderedIds: [] },
        payload: { type: 'order', orderedIds: [] },
      }),
    );
    expect(score.isCorrect).toBe(false);
    expect(score.pointsAwarded).toBe(0);
  });

  it('gives a truth of 0 a band of 0', () => {
    const outcomes = closestNumberOutcomes(0, [
      { playerId: 'near', value: 1 },
      { playerId: 'far', value: 2 },
    ]);
    expect(outcomes.get('near')).toBe('closest');
    expect(outcomes.get('far')).toBe('none');
  });

  it('scores no answer as zero and resets the streak', () => {
    expect(
      scoreQuizAnswer(scoringInput({ payload: null, streakBefore: 4 })),
    ).toEqual({
      isCorrect: false,
      correctPositions: null,
      streakAfter: 0,
      streakBonus: 0,
      pointsAwarded: 0,
    });
  });

  it('matches true or false and typed answers against the key', () => {
    const trueFalseScore = scoreQuizAnswer(
      scoringInput({
        type: 'true_false',
        answerKey: { type: 'true_false', isTrue: false },
        payload: { type: 'true_false', isTrue: false },
      }),
    );
    expect(trueFalseScore.isCorrect).toBe(true);

    const typedScore = scoreQuizAnswer(
      scoringInput({
        type: 'type_answer',
        answerKey: {
          type: 'type_answer',
          text: { en: 'Netherlands', pt: 'Países Baixos' },
          acceptedAnswers: ['Holland'],
        },
        payload: { type: 'type_answer', text: 'paises baixos' },
      }),
    );
    expect(typedScore.isCorrect).toBe(true);
    expect(typedScore.pointsAwarded).toBe(1100);

    const wrongChoice = scoreQuizAnswer(
      scoringInput({
        payload: { type: 'multiple_choice', optionIndex: 0 },
        streakBefore: 3,
      }),
    );
    expect(wrongChoice.isCorrect).toBe(false);
    expect(wrongChoice.streakAfter).toBe(0);
    expect(wrongChoice.pointsAwarded).toBe(0);
  });

  it('doubles the whole question total under a joker', () => {
    const score = scoreQuizAnswer(scoringInput({ isJokerActive: true }));
    expect(score.isCorrect).toBe(true);
    expect(score.streakBonus).toBe(100);
    expect(score.pointsAwarded).toBe(2200);
  });

  it('pays the truth and the fooling', () => {
    const votes = [
      { voterPlayerId: 'truthVoterOne', authorPlayerId: null },
      { voterPlayerId: 'truthVoterTwo', authorPlayerId: null },
      { voterPlayerId: 'fooledOne', authorPlayerId: 'authorA' },
      { voterPlayerId: 'fooledTwo', authorPlayerId: 'authorA' },
      { voterPlayerId: 'fooledThree', authorPlayerId: 'authorA' },
    ];
    const points = scoreLieDetectorVotes({
      votes,
      isJokerActiveFor: isJokerNeverActive,
    });
    expect(points.get('truthVoterOne')).toBe(1000);
    expect(points.get('truthVoterTwo')).toBe(1000);
    expect(points.get('authorA')).toBe(1500);
    expect(points.has('fooledOne')).toBe(false);

    const jokerPoints = scoreLieDetectorVotes({
      votes,
      isJokerActiveFor: (playerId) => playerId === 'authorA',
    });
    expect(jokerPoints.get('authorA')).toBe(3000);
    expect(jokerPoints.get('truthVoterOne')).toBe(1000);
  });

  it('pays votes and the favourite', () => {
    const points = scorePartyVotes({
      votes: [
        { voterPlayerId: 'voterOne', authorPlayerId: 'authorB' },
        { voterPlayerId: 'voterTwo', authorPlayerId: 'authorB' },
        { voterPlayerId: 'voterThree', authorPlayerId: 'authorB' },
      ],
      favouriteAuthorPlayerId: 'authorB',
      isJokerActiveFor: isJokerNeverActive,
    });
    expect(points.get('authorB')).toBe(1250);
    expect(points.has('voterOne')).toBe(false);
  });

  it('averages a team over its eligible members', () => {
    const points = teamQuestionPoints(
      [
        { playerId: 'memberA', teamId: 'teamOne' },
        { playerId: 'memberB', teamId: 'teamOne' },
        { playerId: 'memberC', teamId: 'teamTwo' },
        { playerId: 'memberD', teamId: 'teamTwo' },
      ],
      new Map([['memberA', 1000]]),
    );
    expect(points.get('teamOne')).toBe(500);
    expect(points.get('teamTwo')).toBe(0);
  });

  it('ranks ties together and skips the next rank', () => {
    const ranked = competitionRanks([
      { entrantId: 'entrantThree', score: 200, name: 'Carmen' },
      { entrantId: 'entrantOne', score: 300, name: 'Bianca' },
      { entrantId: 'entrantTwo', score: 300, name: 'alaska' },
    ]);
    expect(ranked.map((entry) => entry.rank)).toEqual([1, 1, 3]);
    expect(ranked.map((entry) => entry.name)).toEqual([
      'alaska',
      'Bianca',
      'Carmen',
    ]);
  });
});
