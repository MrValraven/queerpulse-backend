import {
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import {
  QUIZSHOW_ERRORS,
  quizshowAckFailure,
  quizshowCodeOf,
  quizshowError,
  quizshowErrorWithDetails,
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
});
