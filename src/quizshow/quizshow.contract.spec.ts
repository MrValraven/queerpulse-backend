import {
  QUIZSHOW_ERROR_CODES,
  QUIZSHOW_GAMES_PER_MEMBER_MAX,
  QUIZSHOW_JOIN_CODE_ALPHABET,
  QUIZSHOW_JOIN_CODE_PATTERN,
  QUIZSHOW_LIMITS,
  QUIZSHOW_LOBBY_OPENS_PER_HOUR_MAX,
  QUIZSHOW_OPEN_SESSION_STATUSES,
  QUIZSHOW_PAIRING_CODE_PATTERN,
  QUIZSHOW_PARTY_ROUND_KINDS,
  QUIZSHOW_PHASES,
  QUIZSHOW_PLAYABLE_ROUND_KINDS,
  QUIZSHOW_QUESTION_TYPES,
  QUIZSHOW_QUIZ_PROBLEM_CODES,
  QUIZSHOW_REACTION_IDS,
  QUIZSHOW_ROUND_KINDS,
  QUIZSHOW_SCREEN_LANGUAGES,
  QUIZSHOW_TALK_SECONDS_VALUES,
  QUIZSHOW_TEAM_COLOR_KEYS,
  QUIZSHOW_TEAM_SHAPES,
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

  it('names 24 team colour keys and four timed phases', () => {
    expect(QUIZSHOW_TEAM_COLOR_KEYS).toHaveLength(24);
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
        questionsPerQuizMax: 100,
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
        answerGraceMs: 500,
        extraTimeFactor: 1.5,
        addTimeSecondsMin: 5,
        addTimeSecondsMax: 60,
        streakStep: 100,
        streakCap: 500,
        jokerMultiplier: 2,
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
        teamsPerSessionMax: 24,
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
    expect(QUIZSHOW_QUIZ_PROBLEM_CODES.indexOf('wheel_too_few_slices')).toBe(
      QUIZSHOW_QUIZ_PROBLEM_CODES.indexOf('too_many_wheels') + 1,
    );
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

/** Contract 3.3, both tables in order: the item 8 causes, then the new feature codes, plus the coordinator's per-host pairing code after the network one. */
const PULSE_LIVE_V2_CODES = [
  'quizshow_session_not_started',
  'quizshow_already_started',
  'quizshow_session_paused',
  'quizshow_session_ended',
  'quizshow_spin_not_available',
  'quizshow_no_wheel_open',
  'quizshow_no_timer_running',
  'quizshow_already_revealed',
  'quizshow_nothing_to_reveal',
  'quizshow_nothing_to_skip',
  'quizshow_review_not_open',
  'quizshow_unhide_review_only',
  'quizshow_author_removed',
  'quizshow_favourite_not_available',
  'quizshow_teams_off',
  'quizshow_screen_name_taken',
  'quizshow_joining_locked',
  'quizshow_not_in_lobby',
  'quizshow_move_during_question',
  'quizshow_player_left',
  'quizshow_rescore_not_now',
  'quizshow_accept_needs_typed_answer',
  'quizshow_change_needs_choice_question',
  'quizshow_answer_text_not_found',
  'quizshow_answer_already_correct',
  'quizshow_correct_option_not_found',
  'quizshow_every_option_correct',
  'quizshow_adjust_not_now',
  'quizshow_adjust_below_zero',
  'quizshow_entrant_not_found',
  'quizshow_pairing_code_not_found',
  'quizshow_pairing_code_expired',
  'quizshow_pairing_code_used',
  'quizshow_paired_devices_full',
  'quizshow_helper_cannot_pair',
  'quizshow_helper_is_playing',
  'quizshow_device_not_found',
  'quizshow_device_unpaired',
  'quizshow_device_ticket_expired',
  'quizshow_pairing_not_found',
  'quizshow_pairing_rate_limited',
  'quizshow_pairing_too_many_tries',
  'quizshow_guest_push_cooldown',
  'quizshow_guest_push_already_sent',
  'quizshow_guest_push_needs_event',
  'quizshow_guest_push_practice',
  'quizshow_refresh_quiz_incomplete',
  'quizshow_refresh_adults_mismatch',
  'quizshow_refresh_adults_lobby_joined',
  'quizshow_refresh_quiz_gone',
  'quizshow_rematch_not_found',
  'quizshow_rematch_expired',
  'quizshow_reaction_not_now',
  'quizshow_import_round_not_found',
  'quizshow_import_too_many_rounds',
  'quizshow_import_too_many_questions',
  'quizshow_import_too_many_wheels',
] as const;

describe('Pulse Live v2 contract vocabulary', () => {
  it('keeps the 24 team keys in step with the team limit, the 8 old names first', () => {
    expect(QUIZSHOW_TEAM_COLOR_KEYS).toHaveLength(
      QUIZSHOW_LIMITS.teamsPerSessionMax,
    );
    expect(QUIZSHOW_TEAM_COLOR_KEYS.slice(0, 8)).toEqual([
      'circle',
      'triangle',
      'square',
      'diamond',
      'star',
      'hexagon',
      'heart',
      'moon',
    ]);
    expect(QUIZSHOW_TEAM_COLOR_KEYS.slice(0, 8)).toEqual([
      ...QUIZSHOW_TEAM_SHAPES,
    ]);
  });

  it('adds poll last to the question types', () => {
    expect(QUIZSHOW_QUESTION_TYPES[QUIZSHOW_QUESTION_TYPES.length - 1]).toBe(
      'poll',
    );
  });

  it('widens the screen language and fixes the reaction ids and talk seconds', () => {
    expect(QUIZSHOW_SCREEN_LANGUAGES).toEqual(['en', 'pt', 'both']);
    expect(QUIZSHOW_REACTION_IDS).toEqual([
      'heart',
      'fire',
      'clap',
      'laugh',
      'wow',
      'party',
    ]);
    expect(QUIZSHOW_TALK_SECONDS_VALUES).toEqual([0, 10, 20, 30]);
  });

  it('appends the six new problem codes last, in contract order', () => {
    expect(QUIZSHOW_QUIZ_PROBLEM_CODES.slice(-6)).toEqual([
      'correct_option_missing',
      'too_many_correct_options',
      'tolerance_out_of_range',
      'poll_in_party_round',
      'slow_reveal_needs_picture',
      'warm_up_not_first',
    ]);
  });

  it('puts the new error codes between quizshow_joker_wheel_next and ACCOUNT_RESTRICTED in contract order', () => {
    const start = QUIZSHOW_ERROR_CODES.indexOf('quizshow_joker_wheel_next') + 1;
    const end = QUIZSHOW_ERROR_CODES.indexOf('ACCOUNT_RESTRICTED');
    expect(QUIZSHOW_ERROR_CODES.slice(start, end)).toEqual([
      ...PULSE_LIVE_V2_CODES,
    ]);
    expect(QUIZSHOW_ERROR_CODES).toContain('quizshow_command_not_allowed');
  });

  it('drops the flat read length and the closest band from the limits', () => {
    expect('readPhaseMs' in QUIZSHOW_LIMITS).toBe(false);
    expect('closestNumberBand' in QUIZSHOW_LIMITS).toBe(false);
    expect(QUIZSHOW_LIMITS).toEqual(
      expect.objectContaining({
        readPhaseBaseMs: 1500,
        readPhaseMsPerChar: 25,
        readPhaseMinMs: 3000,
        readPhaseMaxMs: 8000,
        closestLegacyPercent: 10,
        awayAfterMs: 20_000,
        pairedDevicesMax: 6,
        deviceTicketTtlMs: 43_200_000,
        hostTeamsPerCommandMax: 24,
        answerWriteCoalesceMs: 150,
      }),
    );
  });

  it('accepts a pairing code of six digits from 2 to 9', () => {
    expect(QUIZSHOW_PAIRING_CODE_PATTERN.test('234567')).toBe(true);
    expect(QUIZSHOW_PAIRING_CODE_PATTERN.test('123456')).toBe(false);
    expect(QUIZSHOW_PAIRING_CODE_PATTERN.test('23456')).toBe(false);
  });
});
