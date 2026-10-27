import {
  QUIZSHOW_ERROR_CODES,
  QUIZSHOW_GAMES_PER_MEMBER_MAX,
  QUIZSHOW_JOIN_CODE_ALPHABET,
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_LIMITS,
  QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  QUIZSHOW_TEAM_COLOR_KEYS,
  QUIZSHOW_TEMPLATE_CARD_FIELDS,
  QUIZSHOW_TEMPLATE_STATUSES,
  QUIZSHOW_TIMED_PHASES,
} from './quizshow.contract';

describe('Pulse Live contract vocabulary', () => {
  it('accepts a join code from the unambiguous alphabet and refuses the confusable letters', () => {
    expect(QUIZSHOW_JOIN_CODE_PATTERN.test('ABC234')).toBe(true);
    for (const code of [
      'ABCDE1',
      'abc234',
      'ABCDEI',
      'ABCDEO',
      'ABCDEL',
      'ABC23',
      'ABC2345',
    ]) {
      expect(QUIZSHOW_JOIN_CODE_PATTERN.test(code)).toBe(false);
    }
    expect(QUIZSHOW_JOIN_CODE_ALPHABET).toHaveLength(31);
  });

  it('names eight team colour keys and four timed phases', () => {
    expect(QUIZSHOW_TEAM_COLOR_KEYS).toHaveLength(8);
    expect(QUIZSHOW_TIMED_PHASES).toEqual(['read', 'open', 'write', 'vote']);
    expect(QUIZSHOW_OPEN_SESSION_STATUSES).toEqual([
      'lobby',
      'running',
      'paused',
    ]);
  });

  it('carries the limits and scoring numbers of the contract table', () => {
    expect(QUIZSHOW_LIMITS).toEqual(
      expect.objectContaining({
        roundsMax: 10,
        questionsPerQuizMax: 50,
        questionsPerRoundMax: 20,
        multipleChoiceOptionsMin: 2,
        multipleChoiceOptionsMax: 4,
        orderItemsMin: 3,
        orderItemsMax: 6,
        timeLimitSecondsMin: 5,
        timeLimitSecondsMax: 120,
        timeLimitSecondsDefault: 20,
        writeSecondsMin: 15,
        writeSecondsMax: 180,
        writeSecondsDefault: 60,
        voteSecondsMin: 10,
        voteSecondsMax: 90,
        voteSecondsDefault: 30,
        pointsDefault: 1000,
        readPhaseMs: 4000,
        answerGraceMs: 500,
        extraTimeFactor: 1.5,
        addTimeSecondsMin: 5,
        addTimeSecondsMax: 60,
        streakStep: 100,
        streakCap: 500,
        jokerMultiplier: 2,
        closestNumberBand: 0.1,
        lieDetectorTruthPoints: 1000,
        lieDetectorFooledPoints: 500,
        partyVotePoints: 250,
        hostFavouritePoints: 500,
        leaderboardTopCount: 10,
        abandonAfterMs: 7_200_000,
        retentionDays: 30,
        finishedCodeMemoryHours: 12,
        guestPushCooldownMs: 7_200_000,
        importSourcesMax: 50,
        playersPerSessionMax: 150,
        teamsPerSessionMax: 8,
        maxTeamSizeMin: 2,
        maxTeamSizeMax: 20,
        screenNameMax: 30,
        teamNameMax: 40,
        partyTextMax: 80,
        typedAnswerMax: 80,
        numberAbsMax: 1e12,
      }),
    );
    expect(QUIZSHOW_LIMITS.pointsValues).toEqual([500, 1000, 2000]);
    expect(QUIZSHOW_LIMITS.optionIdPattern.test('a1b2')).toBe(true);
    expect(QUIZSHOW_LIMITS.optionIdPattern.test('A1')).toBe(false);
  });

  it('lists the template statuses, card fields and template limits', () => {
    expect(QUIZSHOW_TEMPLATE_STATUSES).toEqual(['draft', 'published']);
    expect(QUIZSHOW_TEMPLATE_CARD_FIELDS).toEqual([
      'title.en',
      'title.pt',
      'description.en',
      'description.pt',
    ]);
    expect(QUIZSHOW_LIMITS.templateCardTitleMax).toBe(120);
    expect(QUIZSHOW_LIMITS.templateCardDescriptionMax).toBe(300);
    expect(QUIZSHOW_LIMITS.templateStaffNotesMax).toBe(20000);
  });

  it('carries no starter pack code', () => {
    expect(QUIZSHOW_ERROR_CODES).not.toContain('quizshow_pack_not_found');
  });

  it('caps games at 50 per member and lobby opens at 10 an hour', () => {
    expect(QUIZSHOW_GAMES_PER_MEMBER_MAX).toBe(50);
    expect(QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX).toBe(10);
  });
});
