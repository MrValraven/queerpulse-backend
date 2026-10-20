import {
  ForbiddenException,
  HttpException,
  HttpStatus,
  NotFoundException,
} from '@nestjs/common';
import {
  QUIZSHOW_ERROR_CODES,
  type QuizshowAckFailure,
  type QuizshowCursor,
  type QuizshowErrorCode,
} from './quizshow.contract';

/** The Lie Detector refusal, in the words of the spec. */
export const QUIZSHOW_FAKE_TOO_CLOSE_MESSAGE =
  'Too close to the real answer, try another';

interface QuizshowErrorRow {
  /** null for socket codes, which travel as acks. */
  status: HttpStatus | null;
  message: string;
}

export const QUIZSHOW_ERRORS: Readonly<
  Record<QuizshowErrorCode, QuizshowErrorRow>
> = {
  // REST
  quizshow_event_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This event was not found.',
  },
  quizshow_not_organiser: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the hosts of this event can do this.',
  },
  quizshow_cohost_is_playing: {
    status: HttpStatus.FORBIDDEN,
    message:
      'A co-host who is playing in a live game of this event cannot manage it.',
  },
  quizshow_quiz_changed: {
    status: HttpStatus.CONFLICT,
    message: 'The quiz of this event changed since it was loaded.',
  },
  quizshow_quiz_invalid: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The quiz of this event has structural problems.',
  },
  quizshow_adults_round_needs_adults_event: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A round for adults needs an event marked 18+.',
  },
  quizshow_quiz_has_adults_rounds: {
    status: HttpStatus.CONFLICT,
    message:
      'This event keeps a quiz with rounds for adults, so it must stay 18+.',
  },
  quizshow_pack_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This starter pack was not found.',
  },
  quizshow_import_source_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'The event to copy a quiz from was not found.',
  },
  quizshow_import_same_event: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'A quiz cannot be copied from the same event.',
  },
  quizshow_quiz_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This event has no quiz yet.',
  },
  quizshow_quiz_incomplete: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'The quiz of this event is not complete yet.',
  },
  quizshow_session_already_open: {
    status: HttpStatus.CONFLICT,
    message: 'This event already has a live game open.',
  },
  quizshow_results_exist: {
    status: HttpStatus.CONFLICT,
    message: 'This event keeps results of an earlier live game.',
  },
  quizshow_event_not_playable: {
    status: HttpStatus.CONFLICT,
    message: 'A live game cannot open on a draft or cancelled event.',
  },
  quizshow_join_code_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'No live game uses this code.',
  },
  quizshow_session_finished: {
    status: HttpStatus.GONE,
    message: 'This live game has ended.',
  },
  quizshow_banned_from_event: {
    status: HttpStatus.FORBIDDEN,
    message: 'This member is barred from the event.',
  },
  quizshow_cannot_view_event: {
    status: HttpStatus.FORBIDDEN,
    message: 'This member cannot view the event.',
  },
  quizshow_player_removed: {
    status: HttpStatus.FORBIDDEN,
    message: 'A host removed this player from the live game of the event.',
  },
  quizshow_organiser_running: {
    status: HttpStatus.CONFLICT,
    message: 'The hosts of an event run the live game and cannot play it.',
  },
  quizshow_session_full: {
    status: HttpStatus.CONFLICT,
    message: 'This live game is full.',
  },
  quizshow_results_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'No results are kept for this event.',
  },
  // socket
  quizshow_session_not_found: {
    status: null,
    message: 'This live game was not found.',
  },
  quizshow_already_attached: {
    status: null,
    message: 'This connection is already attached to a live game.',
  },
  quizshow_not_attached: {
    status: null,
    message: 'This connection is not attached to a live game.',
  },
  quizshow_wrong_role: {
    status: null,
    message: 'This action belongs to another role of the live game.',
  },
  quizshow_not_joined: {
    status: null,
    message: 'Join the live game of the event first.',
  },
  quizshow_stale_phase: {
    status: null,
    message: 'The live game moved on to another phase.',
  },
  quizshow_command_not_allowed: {
    status: null,
    message: 'This command is not allowed in the current phase.',
  },
  quizshow_phase_closed: {
    status: null,
    message: 'This phase of the live game no longer takes answers.',
  },
  quizshow_not_eligible: {
    status: null,
    message:
      'A player who joined after a question opened plays from the next question.',
  },
  quizshow_wrong_question: {
    status: null,
    message: 'This is not the question in play.',
  },
  quizshow_invalid_answer: {
    status: null,
    message: 'This answer does not fit the question.',
  },
  quizshow_text_blank: { status: null, message: 'This text is blank.' },
  quizshow_text_blocked: {
    status: null,
    message: 'This text holds a blocked term.',
  },
  quizshow_fake_too_close: {
    status: null,
    message: QUIZSHOW_FAKE_TOO_CLOSE_MESSAGE,
  },
  quizshow_vote_option_not_found: {
    status: null,
    message: 'This vote option was not found.',
  },
  quizshow_own_answer_vote: {
    status: null,
    message: 'A player cannot vote for their own answer.',
  },
  quizshow_team_not_found: {
    status: null,
    message: 'This team was not found.',
  },
  quizshow_team_full: { status: null, message: 'This team is full.' },
  quizshow_team_limit: {
    status: null,
    message: 'This live game already has the most teams it allows.',
  },
  quizshow_team_name_taken: {
    status: null,
    message: 'Another team of this live game uses this name.',
  },
  quizshow_team_color_taken: {
    status: null,
    message: 'Another team of this live game uses this colour.',
  },
  quizshow_team_required: {
    status: null,
    message: 'A live game in teams mode needs a team to join.',
  },
  quizshow_team_change_closed: {
    status: null,
    message:
      'Names and teams are locked once the live game of the event has started.',
  },
  quizshow_joker_used: {
    status: null,
    message: 'The joker was already played.',
  },
  quizshow_joker_not_allowed: {
    status: null,
    message: 'The joker cannot be played for this round at this moment.',
  },
  quizshow_no_players: {
    status: null,
    message: 'The live game of the event has no players yet.',
  },
  quizshow_player_not_found: {
    status: null,
    message: 'This player was not found in the live game.',
  },
  quizshow_answer_not_found: {
    status: null,
    message: 'This answer was not found in the live game.',
  },
  quizshow_rate_limited: {
    status: null,
    message: 'Too many requests, slow down for the event.',
  },
  // existing, reused as is
  ACCOUNT_RESTRICTED: {
    status: HttpStatus.FORBIDDEN,
    message: 'This account is restricted.',
  },
};

const KNOWN_CODES: ReadonlySet<string> = new Set<string>(QUIZSHOW_ERROR_CODES);

/** Builds the refusal of a REST route: `{ statusCode, code, message }`. */
export function quizshowError(code: QuizshowErrorCode): HttpException {
  return quizshowErrorWithDetails(code, {});
}

/** As `quizshowError`, with extra body fields. The code, status and message win over a detail of the same name. */
export function quizshowErrorWithDetails(
  code: QuizshowErrorCode,
  details: Record<string, unknown>,
): HttpException {
  const row = QUIZSHOW_ERRORS[code];
  if (row.status === null) {
    throw new Error(
      `Quizshow code ${code} is a socket code and has no HTTP status; use quizshowAckFailure.`,
    );
  }
  const body = {
    ...details,
    statusCode: row.status,
    code,
    message: row.message,
  };
  if (row.status === HttpStatus.NOT_FOUND) return new NotFoundException(body);
  if (row.status === HttpStatus.FORBIDDEN) return new ForbiddenException(body);
  return new HttpException(body, row.status);
}

/** Builds the failure ack of a socket frame; `cursor` is present only when given. */
export function quizshowAckFailure(
  code: QuizshowErrorCode,
  cursor?: QuizshowCursor,
): QuizshowAckFailure {
  const failure: QuizshowAckFailure = {
    ok: false,
    code,
    message: QUIZSHOW_ERRORS[code].message,
  };
  if (cursor !== undefined) failure.cursor = cursor;
  return failure;
}

/** Reads the quizshow code back from a thrown refusal; null for anything else. */
export function quizshowCodeOf(error: unknown): QuizshowErrorCode | null {
  if (!(error instanceof HttpException)) return null;
  const body = error.getResponse();
  if (typeof body !== 'object' || body === null) return null;
  const code = (body as { code?: unknown }).code;
  return typeof code === 'string' && KNOWN_CODES.has(code)
    ? (code as QuizshowErrorCode)
    : null;
}
