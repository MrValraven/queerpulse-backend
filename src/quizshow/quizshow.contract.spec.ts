import {
  QUIZSHOW_ERROR_CODES,
  QUIZSHOW_GAMES_PER_MEMBER_MAX,
  QUIZSHOW_JOIN_CODE_ALPHABET,
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_LIMITS,
  QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  QUIZSHOW_PARTY_ROUND_KINDS,
  QUIZSHOW_PHASES,
  QUIZSHOW_PLAYABLE_ROUND_KINDS,
  QUIZSHOW_QUIZ_PROBLEM_CODES,
  QUIZSHOW_ROUND_KINDS,
  QUIZSHOW_TEAM_COLOR_KEYS,
  QUIZSHOW_TEMPLATE_CARD_FIELDS,
  QUIZSHOW_TEMPLATE_STATUSES,
  QUIZSHOW_TIMED_PHASES,
  QUIZSHOW_WHEEL_BONUS_VALUES,
  QUIZSHOW_WHEEL_PICKS,
  QUIZSHOW_WHEEL_SETTINGS_DEFAULTS,
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

  it('adds the wheel kind last and keeps it out of the playable and party kinds', () => {
    expect(QUIZSHOW_ROUND_KINDS).toEqual([
      'quiz',
      'lie_detector',
      'caption_this',
      'drag_name',
      'wheel',
    ]);
    expect(QUIZSHOW_PLAYABLE_ROUND_KINDS).toEqual([
      'quiz',
      'lie_detector',
      'caption_this',
      'drag_name',
    ]);
    expect(QUIZSHOW_PARTY_ROUND_KINDS).not.toContain('wheel');
  });

  it('puts the untimed wheel phase after the leaderboard', () => {
    expect(QUIZSHOW_PHASES.indexOf('wheel')).toBe(
      QUIZSHOW_PHASES.indexOf('leaderboard') + 1,
    );
    expect(QUIZSHOW_TIMED_PHASES).not.toContain('wheel');
  });

  it('carries the wheel vocabulary, defaults and limits', () => {
    expect(QUIZSHOW_WHEEL_PICKS).toEqual(['round', 'question']);
    expect(QUIZSHOW_WHEEL_BONUS_VALUES).toEqual([0, 250, 500, 1000]);
    expect(QUIZSHOW_WHEEL_SETTINGS_DEFAULTS).toEqual({
      wheelBonus: 0,
      wheelPick: 'round',
      sliceCount: null,
    });
    expect(QUIZSHOW_LIMITS).toEqual(
      expect.objectContaining({
        roundsMax: 10,
        roundRowsMax: 13,
        wheelStepsMax: 3,
        wheelSlicesMin: 2,
        wheelSlicesMax: 8,
        wheelSpinMs: 5500,
        wheelSpinReducedMotionMs: 1200,
        wheelTurnsMin: 5,
        wheelTurnsMax: 6,
        wheelJitterSeedMax: 1000,
        wheelJitterSpread: 0.7,
        wheelPointerAngle: 270,
        wheelLandingToleranceMs: 250,
      }),
    );
  });

  it('appends the wheel problem codes and socket codes', () => {
    expect(QUIZSHOW_QUIZ_PROBLEM_CODES.slice(-2)).toEqual([
      'too_many_wheels',
      'wheel_too_few_slices',
    ]);
    expect(QUIZSHOW_ERROR_CODES).toEqual(
      expect.arrayContaining([
        'quizshow_wheel_not_spun',
        'quizshow_wheel_spinning',
        'quizshow_wheel_spin_too_few_rounds',
        'quizshow_wheel_already_next',
        'quizshow_joker_wheel_next',
      ]),
    );
    expect(
      QUIZSHOW_ERROR_CODES.indexOf('quizshow_wheel_not_spun'),
    ).toBeLessThan(QUIZSHOW_ERROR_CODES.indexOf('ACCOUNT_RESTRICTED'));
  });
});
