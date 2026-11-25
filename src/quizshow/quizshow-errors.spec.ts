import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  QUIZSHOW_ERRORS,
  quizshowAckFailure,
  quizshowCodeOf,
  quizshowError,
  quizshowErrorWithDetails,
  quizshowErrorWithStatus,
} from './quizshow-errors';
import {
  QUIZSHOW_ERROR_CODES,
  type QuizshowCursor,
  type QuizshowErrorCode,
} from './quizshow.contract';

const cursorFixture: QuizshowCursor = {
  phaseId: '7',
  status: 'running',
  phase: 'open',
  roundIndex: 0,
  questionIndex: 1,
  roundCount: 3,
  phaseStartedAt: 1_760_000_000_000,
  deadline: 1_760_000_020_000,
  extraTimeDeadline: 1_760_000_030_000,
  pausedRemainingMs: null,
  pausedExtraTimeRemainingMs: null,
  isRestartRecovery: false,
  roundNumber: 1,
  upNext: null,
  canSpinForNextRound: false,
  talkStartsAt: null,
  autoAdvanceAt: null,
  podiumRevealedCount: null,
};

const REST_ROWS: Array<[QuizshowErrorCode, number]> = [
  ['quizshow_event_not_found', 404],
  ['quizshow_not_organiser', 403],
  ['quizshow_cohost_is_playing', 403],
  ['quizshow_quiz_changed', 409],
  ['quizshow_quiz_invalid', 422],
  ['quizshow_adults_round_needs_adults_event', 422],
  ['quizshow_quiz_has_adults_rounds', 409],
  ['quizshow_import_source_not_found', 404],
  ['quizshow_import_same_event', 422],
  ['quizshow_quiz_not_found', 404],
  ['quizshow_quiz_incomplete', 422],
  ['quizshow_session_already_open', 409],
  ['quizshow_results_exist', 409],
  ['quizshow_event_not_playable', 409],
  ['quizshow_join_code_not_found', 404],
  ['quizshow_session_finished', 410],
  ['quizshow_banned_from_event', 403],
  ['quizshow_cannot_view_event', 403],
  ['quizshow_player_removed', 403],
  ['quizshow_organiser_running', 409],
  ['quizshow_session_full', 409],
  ['quizshow_results_not_found', 404],
  ['quizshow_game_not_found', 404],
  ['quizshow_game_limit_reached', 403],
  ['quizshow_lobby_rate_limited', 429],
  ['quizshow_game_adults_rounds_need_switch', 403],
  ['quizshow_template_not_found', 404],
  ['quizshow_template_card_incomplete', 422],
];

describe('quizshow errors', () => {
  it.each(REST_ROWS)(
    'answers %s with status %i and the matching exception class',
    (code, status) => {
      const error = quizshowError(code);
      expect(error.getStatus()).toBe(status);
      expect(error instanceof NotFoundException).toBe(status === 404);
      expect(error instanceof ForbiddenException).toBe(status === 403);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        code,
        message: expect.any(String) as string,
      });
    },
  );

  it('answers ACCOUNT_RESTRICTED with 403', () => {
    expect(
      quizshowError('ACCOUNT_RESTRICTED') instanceof ForbiddenException,
    ).toBe(true);
  });

  it('gives every socket code no HTTP status', () => {
    for (const code of [
      'quizshow_stale_phase',
      'quizshow_phase_closed',
      'quizshow_rate_limited',
      'quizshow_adult_consent_required',
    ] as const) {
      expect(QUIZSHOW_ERRORS[code].status).toBeNull();
    }
    expect(Object.keys(QUIZSHOW_ERRORS).sort()).toEqual(
      [...QUIZSHOW_ERROR_CODES].sort(),
    );
  });

  it('refuses to build an HTTP exception for a socket code', () => {
    expect(() => quizshowError('quizshow_stale_phase')).toThrow(/socket code/);
    expect(() => quizshowErrorWithDetails('quizshow_rate_limited', {})).toThrow(
      /socket code/,
    );
  });

  it('keeps the code, status and message over details of the same name', () => {
    const body = quizshowErrorWithDetails('quizshow_quiz_changed', {
      code: 'x',
      statusCode: 200,
      updatedAt: null,
    }).getResponse();
    expect(body).toEqual({
      statusCode: 409,
      code: 'quizshow_quiz_changed',
      message: expect.any(String) as string,
      updatedAt: null,
    });
  });

  it('adds the cursor to an ack failure only when one is given', () => {
    expect(quizshowAckFailure('quizshow_rate_limited')).toEqual({
      ok: false,
      code: 'quizshow_rate_limited',
      message: expect.any(String) as string,
    });
    expect('cursor' in quizshowAckFailure('quizshow_rate_limited')).toBe(false);
    expect(
      quizshowAckFailure('quizshow_stale_phase', cursorFixture),
    ).toHaveProperty('cursor', cursorFixture);
  });

  it('names the quiz to copy from when an import source is missing', () => {
    expect(QUIZSHOW_ERRORS.quizshow_import_source_not_found.message).toBe(
      'The quiz to copy from was not found.',
    );
  });

  it('names the template and the card in the template refusals', () => {
    expect(QUIZSHOW_ERRORS.quizshow_template_not_found.message).toBe(
      'This quiz template was not found.',
    );
    expect(QUIZSHOW_ERRORS.quizshow_template_card_incomplete.message).toBe(
      'The template card needs a title and a description in every language the quiz uses.',
    );
  });

  it('says the Lie Detector refusal in the words of the spec', () => {
    expect(QUIZSHOW_ERRORS.quizshow_fake_too_close.message).toBe(
      'Too close to the real answer, try another',
    );
  });

  it('reads the code back from a thrown refusal', () => {
    expect(quizshowCodeOf(quizshowError('quizshow_player_removed'))).toBe(
      'quizshow_player_removed',
    );
    expect(quizshowCodeOf(new Error('boom'))).toBeNull();
    expect(
      quizshowCodeOf(new HttpException({ code: 'not_ours' }, 400)),
    ).toBeNull();
    expect(quizshowCodeOf(new HttpException('plain', 400))).toBeNull();
  });

  it('ends every message with a full stop', () => {
    for (const code of QUIZSHOW_ERROR_CODES) {
      if (code === 'quizshow_fake_too_close') continue;
      expect(QUIZSHOW_ERRORS[code].message.endsWith('.')).toBe(true);
    }
  });

  it.each([
    ['quizshow_wheel_not_spun', 'The wheel has not been spun yet.'],
    ['quizshow_wheel_spinning', 'The wheel is still spinning.'],
    [
      'quizshow_wheel_spin_too_few_rounds',
      'Spinning for the next round needs at least 2 unplayed rounds outside a wheel.',
    ],
    ['quizshow_wheel_already_next', 'A wheel step comes next on its own.'],
    [
      'quizshow_joker_wheel_next',
      'A wheel picks the next round, so the joker waits for its round card.',
    ],
  ] as const)('names the cause of %s as a socket code', (code, message) => {
    expect(QUIZSHOW_ERRORS[code]).toEqual({ status: null, message });
    expect('cursor' in quizshowAckFailure(code)).toBe(false);
  });
});

/** Contract 3.3 plus the coordinator's per-host pairing code: every new code with its status (null for socket codes) and its log message. */
const PULSE_LIVE_V2_ROWS: Array<[QuizshowErrorCode, number | null, string]> = [
  ['quizshow_session_not_started', null, "The game hasn't started yet."],
  ['quizshow_already_started', null, 'The game has already started.'],
  ['quizshow_session_paused', null, 'The game is paused. Resume it first.'],
  ['quizshow_session_ended', null, 'This game has ended.'],
  [
    'quizshow_spin_not_available',
    null,
    'You can spin on a wheel or between rounds.',
  ],
  ['quizshow_no_wheel_open', null, 'No wheel is open right now.'],
  ['quizshow_no_timer_running', null, 'No timer is running to add time to.'],
  ['quizshow_already_revealed', null, 'The answer is already showing.'],
  [
    'quizshow_nothing_to_reveal',
    null,
    'No question is taking answers to reveal.',
  ],
  ['quizshow_nothing_to_skip', null, "There's no question to skip right now."],
  ['quizshow_review_not_open', null, "The answers aren't in review right now."],
  [
    'quizshow_unhide_review_only',
    null,
    'You can show an answer again only while reviewing.',
  ],
  [
    'quizshow_author_removed',
    null,
    'The person who wrote this is no longer in the game.',
  ],
  [
    'quizshow_favourite_not_available',
    null,
    'Pick a favourite when a written round shows its answers.',
  ],
  ['quizshow_teams_off', null, 'This game is played solo, so it has no teams.'],
  ['quizshow_screen_name_taken', null, 'Someone here already uses that name.'],
  ['quizshow_joining_locked', 403, 'The host closed joining for this game.'],
  ['quizshow_not_in_lobby', 409, 'This works only before the game starts.'],
  ['quizshow_move_during_question', null, 'Move people between questions.'],
  ['quizshow_player_left', null, 'That person left the game.'],
  [
    'quizshow_rescore_not_now',
    null,
    "Fix answers while this question's answer is showing.",
  ],
  [
    'quizshow_accept_needs_typed_answer',
    null,
    'Only typed answers can be accepted.',
  ],
  [
    'quizshow_change_needs_choice_question',
    null,
    'Only a multiple choice or true or false answer can be changed.',
  ],
  ['quizshow_answer_text_not_found', null, 'Nobody wrote that answer.'],
  [
    'quizshow_answer_already_correct',
    null,
    'That answer already counts as correct.',
  ],
  [
    'quizshow_correct_option_not_found',
    null,
    "That option isn't in this question.",
  ],
  [
    'quizshow_every_option_correct',
    null,
    'At least one option has to stay wrong.',
  ],
  [
    'quizshow_adjust_not_now',
    null,
    'Change points while the game runs, before the podium.',
  ],
  ['quizshow_adjust_below_zero', null, "A score can't go below 0."],
  [
    'quizshow_entrant_not_found',
    null,
    "That player or team isn't in this game.",
  ],
  ['quizshow_pairing_code_not_found', null, 'No screen is showing that code.'],
  [
    'quizshow_pairing_code_expired',
    null,
    'That code expired. Show a new one on the other screen.',
  ],
  ['quizshow_pairing_code_used', null, 'That code is already paired.'],
  [
    'quizshow_paired_devices_full',
    null,
    'This game already has 6 paired devices. Unpair one first.',
  ],
  [
    'quizshow_helper_cannot_pair',
    null,
    "Only the game's host can pair devices.",
  ],
  [
    'quizshow_helper_is_playing',
    null,
    "That person is playing this game, so they can't run it.",
  ],
  [
    'quizshow_device_not_found',
    null,
    "That device isn't paired with this game.",
  ],
  ['quizshow_device_unpaired', null, 'The host unpaired this screen.'],
  [
    'quizshow_device_ticket_expired',
    null,
    'This pairing expired. Pair the screen again.',
  ],
  ['quizshow_pairing_not_found', 404, 'This code is gone. Show a new one.'],
  [
    'quizshow_pairing_rate_limited',
    429,
    'Too many pairing codes right now. Try again in a few minutes.',
  ],
  [
    'quizshow_pairing_too_many_tries',
    null,
    'Too many wrong codes. Wait a few minutes and try again.',
  ],
  [
    'quizshow_guest_push_cooldown',
    null,
    'Guests were told less than 2 hours ago.',
  ],
  [
    'quizshow_guest_push_already_sent',
    null,
    "Guests already have this game's code.",
  ],
  [
    'quizshow_guest_push_needs_event',
    null,
    "Only an event's game can notify guests.",
  ],
  ['quizshow_guest_push_practice', null, 'A practice lobby notifies nobody.'],
  [
    'quizshow_refresh_quiz_incomplete',
    422,
    'Your latest edits have problems to fix before this lobby can use them.',
  ],
  [
    'quizshow_refresh_adults_mismatch',
    422,
    "Your latest edits have an 18+ round this game can't hold.",
  ],
  [
    'quizshow_refresh_adults_lobby_joined',
    409,
    "People already joined, so this game can't turn 18+ now. Open a new lobby for the 18+ version.",
  ],
  ['quizshow_refresh_quiz_gone', 404, 'This quiz no longer exists.'],
  [
    'quizshow_rematch_not_found',
    404,
    "There's no finished game here to replay.",
  ],
  [
    'quizshow_rematch_expired',
    409,
    'A rematch opens up to 30 minutes after a game ends.',
  ],
  ['quizshow_reaction_not_now', null, 'Reactions open between questions.'],
  [
    'quizshow_import_round_not_found',
    422,
    'One of the chosen rounds is no longer in that quiz.',
  ],
  [
    'quizshow_import_too_many_rounds',
    422,
    'Adding these rounds goes over the 10 round limit.',
  ],
  [
    'quizshow_import_too_many_questions',
    422,
    'Adding these rounds goes over 100 questions.',
  ],
  [
    'quizshow_import_too_many_wheels',
    422,
    'Adding these rounds goes over 3 wheels.',
  ],
];

describe('quizshow errors of Pulse Live v2', () => {
  it.each(PULSE_LIVE_V2_ROWS)(
    'gives %s the status %s and its log message',
    (code, status, message) => {
      expect(QUIZSHOW_ERRORS[code]).toEqual({ status, message });
    },
  );

  it('builds the REST body of every new code with an HTTP status', () => {
    for (const [code, status] of PULSE_LIVE_V2_ROWS) {
      if (status === null) continue;
      const error = quizshowError(code);
      expect(error.getStatus()).toBe(status);
      expect(error.getResponse()).toEqual({
        statusCode: status,
        code,
        message: QUIZSHOW_ERRORS[code].message,
      });
    }
  });

  it('answers a full pairing code space with 503 and the rate-limit code', () => {
    const error = quizshowErrorWithStatus(
      'quizshow_pairing_rate_limited',
      HttpStatus.SERVICE_UNAVAILABLE,
    );
    expect(error.getStatus()).toBe(503);
    expect(error.getResponse()).toEqual({
      statusCode: 503,
      code: 'quizshow_pairing_rate_limited',
      message: QUIZSHOW_ERRORS.quizshow_pairing_rate_limited.message,
    });
    expect(quizshowCodeOf(error)).toBe('quizshow_pairing_rate_limited');
    expect(QUIZSHOW_ERRORS.quizshow_pairing_rate_limited.status).toBe(
      HttpStatus.TOO_MANY_REQUESTS,
    );
  });

  it('carries the suggested screen name on a taken name and leaves it out otherwise', () => {
    expect(
      quizshowAckFailure('quizshow_screen_name_taken', undefined, {
        suggestedScreenName: 'Alex 2',
      }),
    ).toEqual({
      ok: false,
      code: 'quizshow_screen_name_taken',
      message: 'Someone here already uses that name.',
      suggestedScreenName: 'Alex 2',
    });
    expect(
      'suggestedScreenName' in quizshowAckFailure('quizshow_screen_name_taken'),
    ).toBe(false);
    expect(
      quizshowAckFailure('quizshow_session_paused', cursorFixture),
    ).toHaveProperty('cursor', cursorFixture);
  });
});
