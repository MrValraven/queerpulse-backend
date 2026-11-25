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
  quizshow_import_source_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'The quiz to copy from was not found.',
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
  quizshow_game_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This game was not found.',
  },
  quizshow_game_limit_reached: {
    status: HttpStatus.FORBIDDEN,
    message: 'This member already keeps the most games allowed.',
  },
  quizshow_lobby_rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many live games were opened in the last hour.',
  },
  quizshow_game_adults_rounds_need_switch: {
    status: HttpStatus.FORBIDDEN,
    message: 'A round for adults needs the game marked 18+.',
  },
  quizshow_template_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This quiz template was not found.',
  },
  quizshow_template_card_incomplete: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'The template card needs a title and a description in every language the quiz uses.',
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
  quizshow_adult_consent_required: {
    status: null,
    message: 'This game holds 18+ content and needs a confirmation to join.',
  },
  quizshow_wheel_not_spun: {
    status: null,
    message: 'The wheel has not been spun yet.',
  },
  quizshow_wheel_spinning: {
    status: null,
    message: 'The wheel is still spinning.',
  },
  quizshow_wheel_spin_too_few_rounds: {
    status: null,
    message:
      'Spinning for the next round needs at least 2 unplayed rounds outside a wheel.',
  },
  quizshow_wheel_already_next: {
    status: null,
    message: 'A wheel step comes next on its own.',
  },
  quizshow_joker_wheel_next: {
    status: null,
    message:
      'A wheel picks the next round, so the joker waits for its round card.',
  },
  // item 8: the causes behind a refused host or player command
  quizshow_session_not_started: {
    status: null,
    message: "The game hasn't started yet.",
  },
  quizshow_already_started: {
    status: null,
    message: 'The game has already started.',
  },
  quizshow_session_paused: {
    status: null,
    message: 'The game is paused. Resume it first.',
  },
  quizshow_session_ended: { status: null, message: 'This game has ended.' },
  quizshow_spin_not_available: {
    status: null,
    message: 'You can spin on a wheel or between rounds.',
  },
  quizshow_no_wheel_open: {
    status: null,
    message: 'No wheel is open right now.',
  },
  quizshow_no_timer_running: {
    status: null,
    message: 'No timer is running to add time to.',
  },
  quizshow_already_revealed: {
    status: null,
    message: 'The answer is already showing.',
  },
  quizshow_nothing_to_reveal: {
    status: null,
    message: 'No question is taking answers to reveal.',
  },
  quizshow_nothing_to_skip: {
    status: null,
    message: "There's no question to skip right now.",
  },
  quizshow_review_not_open: {
    status: null,
    message: "The answers aren't in review right now.",
  },
  quizshow_unhide_review_only: {
    status: null,
    message: 'You can show an answer again only while reviewing.',
  },
  quizshow_author_removed: {
    status: null,
    message: 'The person who wrote this is no longer in the game.',
  },
  quizshow_favourite_not_available: {
    status: null,
    message: 'Pick a favourite when a written round shows its answers.',
  },
  quizshow_teams_off: {
    status: null,
    message: 'This game is played solo, so it has no teams.',
  },
  // Pulse Live v2 features
  /** The FE copy adds "Try {{suggestion}}"; the server log keeps the sentence without it. */
  quizshow_screen_name_taken: {
    status: null,
    message: 'Someone here already uses that name.',
  },
  quizshow_joining_locked: {
    status: HttpStatus.FORBIDDEN,
    message: 'The host closed joining for this game.',
  },
  quizshow_not_in_lobby: {
    status: HttpStatus.CONFLICT,
    message: 'This works only before the game starts.',
  },
  quizshow_move_during_question: {
    status: null,
    message: 'Move people between questions.',
  },
  quizshow_player_left: { status: null, message: 'That person left the game.' },
  quizshow_rescore_not_now: {
    status: null,
    message: "Fix answers while this question's answer is showing.",
  },
  quizshow_accept_needs_typed_answer: {
    status: null,
    message: 'Only typed answers can be accepted.',
  },
  quizshow_change_needs_choice_question: {
    status: null,
    message: 'Only a multiple choice or true or false answer can be changed.',
  },
  quizshow_answer_text_not_found: {
    status: null,
    message: 'Nobody wrote that answer.',
  },
  quizshow_answer_already_correct: {
    status: null,
    message: 'That answer already counts as correct.',
  },
  quizshow_correct_option_not_found: {
    status: null,
    message: "That option isn't in this question.",
  },
  quizshow_every_option_correct: {
    status: null,
    message: 'At least one option has to stay wrong.',
  },
  quizshow_adjust_not_now: {
    status: null,
    message: 'Change points while the game runs, before the podium.',
  },
  quizshow_adjust_below_zero: {
    status: null,
    message: "A score can't go below 0.",
  },
  quizshow_entrant_not_found: {
    status: null,
    message: "That player or team isn't in this game.",
  },
  quizshow_pairing_code_not_found: {
    status: null,
    message: 'No screen is showing that code.',
  },
  quizshow_pairing_code_expired: {
    status: null,
    message: 'That code expired. Show a new one on the other screen.',
  },
  quizshow_pairing_code_used: {
    status: null,
    message: 'That code is already paired.',
  },
  quizshow_paired_devices_full: {
    status: null,
    message: 'This game already has 6 paired devices. Unpair one first.',
  },
  quizshow_helper_cannot_pair: {
    status: null,
    message: "Only the game's host can pair devices.",
  },
  quizshow_helper_is_playing: {
    status: null,
    message: "That person is playing this game, so they can't run it.",
  },
  quizshow_device_not_found: {
    status: null,
    message: "That device isn't paired with this game.",
  },
  quizshow_device_unpaired: {
    status: null,
    message: 'The host unpaired this screen.',
  },
  quizshow_device_ticket_expired: {
    status: null,
    message: 'This pairing expired. Pair the screen again.',
  },
  quizshow_pairing_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: 'This code is gone. Show a new one.',
  },
  quizshow_pairing_rate_limited: {
    status: HttpStatus.TOO_MANY_REQUESTS,
    message: 'Too many pairing codes right now. Try again in a few minutes.',
  },
  quizshow_pairing_too_many_tries: {
    status: null,
    message: 'Too many wrong codes. Wait a few minutes and try again.',
  },
  quizshow_guest_push_cooldown: {
    status: null,
    message: 'Guests were told less than 2 hours ago.',
  },
  quizshow_guest_push_already_sent: {
    status: null,
    message: "Guests already have this game's code.",
  },
  quizshow_guest_push_needs_event: {
    status: null,
    message: "Only an event's game can notify guests.",
  },
  quizshow_guest_push_practice: {
    status: null,
    message: 'A practice lobby notifies nobody.',
  },
  quizshow_refresh_quiz_incomplete: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message:
      'Your latest edits have problems to fix before this lobby can use them.',
  },
  quizshow_refresh_adults_mismatch: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: "Your latest edits have an 18+ round this game can't hold.",
  },
  quizshow_refresh_adults_lobby_joined: {
    status: HttpStatus.CONFLICT,
    message:
      "People already joined, so this game can't turn 18+ now. Open a new lobby for the 18+ version.",
  },
  quizshow_refresh_quiz_gone: {
    status: HttpStatus.NOT_FOUND,
    message: 'This quiz no longer exists.',
  },
  quizshow_rematch_not_found: {
    status: HttpStatus.NOT_FOUND,
    message: "There's no finished game here to replay.",
  },
  quizshow_rematch_expired: {
    status: HttpStatus.CONFLICT,
    message: 'A rematch opens up to 30 minutes after a game ends.',
  },
  quizshow_reaction_not_now: {
    status: null,
    message: 'Reactions open between questions.',
  },
  quizshow_import_round_not_found: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'One of the chosen rounds is no longer in that quiz.',
  },
  quizshow_import_too_many_rounds: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Adding these rounds goes over the 10 round limit.',
  },
  quizshow_import_too_many_questions: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Adding these rounds goes over 100 questions.',
  },
  quizshow_import_too_many_wheels: {
    status: HttpStatus.UNPROCESSABLE_ENTITY,
    message: 'Adding these rounds goes over 3 wheels.',
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

/** The code's body with another HTTP status: a full pairing code space reads as overload (503), the code stays the rate-limit one. */
export function quizshowErrorWithStatus(
  code: QuizshowErrorCode,
  status: HttpStatus,
): HttpException {
  return new HttpException(
    { statusCode: status, code, message: QUIZSHOW_ERRORS[code].message },
    status,
  );
}

/** Builds the failure ack of a socket frame; `cursor` and `suggestedScreenName` are present only when given. */
export function quizshowAckFailure(
  code: QuizshowErrorCode,
  cursor?: QuizshowCursor,
  extra?: Pick<QuizshowAckFailure, 'suggestedScreenName'>,
): QuizshowAckFailure {
  const failure: QuizshowAckFailure = {
    ok: false,
    code,
    message: QUIZSHOW_ERRORS[code].message,
  };
  if (cursor !== undefined) failure.cursor = cursor;
  if (extra?.suggestedScreenName !== undefined) {
    failure.suggestedScreenName = extra.suggestedScreenName;
  }
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
