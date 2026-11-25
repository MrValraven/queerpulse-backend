import { HttpException, HttpStatus } from '@nestjs/common';

/** Every reason code the quiz badge routes answer with. */
export type QuizWinBadgeRefusalCode =
  | 'quiz_badge_not_found'
  | 'quiz_badge_text_invalid'
  | 'quiz_badge_name_required'
  | 'quiz_badge_name_too_long'
  | 'quiz_badge_name_taken'
  | 'quiz_badge_description_required'
  | 'quiz_badge_description_too_long'
  | 'quiz_badge_icon_unknown'
  | 'quiz_badge_tint_unknown'
  | 'quiz_badge_rarity_unknown'
  | 'quiz_badge_archived'
  | 'quiz_badge_in_use'
  | 'quiz_badge_event_not_found'
  | 'quiz_badge_event_has_no_quiz'
  | 'quiz_badge_setup_invalid'
  | 'quiz_badge_game_number_invalid'
  | 'quiz_badge_game_limit_reached'
  | 'quiz_badge_slot_limit_reached'
  | 'quiz_badge_slot_duplicate'
  | 'quiz_badge_winner_not_found'
  | 'quiz_badge_winner_already_revoked'
  | 'quiz_badge_revoke_reason_required'
  | 'quiz_badge_revoke_reason_too_long';

/** The status and message template of each refusal code. A template keeps its
 *  `{field}`, `{language}`, `{holderCount}`, `{limit}`, `{gameNumber}` and
 *  `{revokedAt}` placeholders; `quizWinBadgeError` fills them. */
export const QUIZ_WIN_BADGE_REFUSALS: Record<
  QuizWinBadgeRefusalCode,
  { status: HttpStatus; message: string }
> = {
  quiz_badge_not_found: {
    status: HttpStatus.NOT_FOUND,
    message:
      'This badge was deleted. Reload the list to see the current badges.',
  },
  quiz_badge_text_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The {field} could not be read as text. Retype it and save again.',
  },
  quiz_badge_name_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Add an English name. Members see it when Portuguese is missing.',
  },
  quiz_badge_name_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Badge names fit in 40 characters. Shorten the {language} name.',
  },
  quiz_badge_name_taken: {
    status: HttpStatus.CONFLICT,
    message:
      'Another badge already uses this {language} name. Pick a different one.',
  },
  quiz_badge_description_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Add an English description. Winners read it as the earned text.',
  },
  quiz_badge_description_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Descriptions fit in 140 characters. Shorten the {language} one.',
  },
  quiz_badge_icon_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'That icon is outside the badge icon set. Pick one from the list.',
  },
  quiz_badge_tint_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Pick one of the three badge colours: jade, coral or plum.',
  },
  quiz_badge_rarity_unknown: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Pick a rarity: common, rare or legendary.',
  },
  quiz_badge_archived: {
    status: HttpStatus.CONFLICT,
    message:
      'This badge is archived, so it can only stay on games that already give it. Restore it to attach it here.',
  },
  quiz_badge_in_use: {
    status: HttpStatus.CONFLICT,
    message:
      '{holderCount} members hold this badge, so it can only be archived.',
  },
  quiz_badge_event_not_found: {
    status: HttpStatus.NOT_FOUND,
    message:
      'This event was deleted or its link is wrong. Search for it again.',
  },
  quiz_badge_event_has_no_quiz: {
    status: HttpStatus.CONFLICT,
    message:
      "This event has no Pulse Live quiz yet. Its host adds one in the event's quiz builder.",
  },
  quiz_badge_setup_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The game setup arrived in a shape the server could not read. Reload the page and save again.',
  },
  quiz_badge_game_number_invalid: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Game numbers are whole numbers from 1.',
  },
  quiz_badge_game_limit_reached: {
    status: HttpStatus.BAD_REQUEST,
    message: 'An event gives badges for up to {limit} games.',
  },
  quiz_badge_slot_limit_reached: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'Game {gameNumber} already gives {limit} badges, the most one game can give.',
  },
  quiz_badge_slot_duplicate: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Game {gameNumber} lists the same badge twice.',
  },
  quiz_badge_winner_not_found: {
    status: HttpStatus.NOT_FOUND,
    message:
      'This winner record belongs to another event or no longer exists. Reload the page.',
  },
  quiz_badge_winner_already_revoked: {
    status: HttpStatus.CONFLICT,
    message:
      'Another admin already revoked this win on {revokedAt}. Reload the page to see it.',
  },
  quiz_badge_revoke_reason_required: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Add a reason. The moderation log keeps it with the revoke.',
  },
  quiz_badge_revoke_reason_too_long: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Reasons fit in 300 characters. Shorten this one.',
  },
};

/** The extra body fields a quiz badge refusal can carry. */
export interface QuizWinBadgeErrorExtras {
  definitionId?: string;
  field?: 'name.en' | 'name.pt' | 'description.en' | 'description.pt';
  language?: 'en' | 'pt';
  maxLength?: number;
  holderCount?: number;
  gameNumber?: number;
  limit?: number;
  revokedAt?: string;
}

/** The extra body fields each code carries. `quizWinBadgeError` copies only
 *  these and only when the matching extra is defined. */
export const QUIZ_WIN_BADGE_REFUSAL_EXTRAS: Record<
  QuizWinBadgeRefusalCode,
  readonly (keyof QuizWinBadgeErrorExtras)[]
> = {
  quiz_badge_not_found: ['definitionId'],
  quiz_badge_text_invalid: ['field'],
  quiz_badge_name_required: ['language'],
  quiz_badge_name_too_long: ['language', 'maxLength'],
  quiz_badge_name_taken: ['language'],
  quiz_badge_description_required: ['language'],
  quiz_badge_description_too_long: ['language', 'maxLength'],
  quiz_badge_icon_unknown: [],
  quiz_badge_tint_unknown: [],
  quiz_badge_rarity_unknown: [],
  quiz_badge_archived: ['definitionId'],
  quiz_badge_in_use: ['holderCount'],
  quiz_badge_event_not_found: [],
  quiz_badge_event_has_no_quiz: [],
  quiz_badge_setup_invalid: [],
  quiz_badge_game_number_invalid: ['gameNumber'],
  quiz_badge_game_limit_reached: ['limit'],
  quiz_badge_slot_limit_reached: ['limit', 'gameNumber'],
  quiz_badge_slot_duplicate: ['gameNumber', 'definitionId'],
  quiz_badge_winner_not_found: [],
  quiz_badge_winner_already_revoked: ['revokedAt'],
  quiz_badge_revoke_reason_required: [],
  quiz_badge_revoke_reason_too_long: ['maxLength'],
};

const LANGUAGE_NAMES: Record<'en' | 'pt', string> = {
  en: 'English',
  pt: 'Portuguese',
};

/** Fills every `{key}` of a template from the extras. `{language}` reads as
 *  English or Portuguese; a placeholder whose extra is absent stays as written. */
function fillMessageTemplate(
  template: string,
  extras: QuizWinBadgeErrorExtras | undefined,
): string {
  return template.replace(/\{(\w+)\}/g, (placeholder, key: string) => {
    const value = extras?.[key as keyof QuizWinBadgeErrorExtras];
    if (value === undefined) {
      return placeholder;
    }
    if (key === 'language') {
      return LANGUAGE_NAMES[value as 'en' | 'pt'] ?? String(value);
    }
    return String(value);
  });
}

/** The one way the quiz badge routes refuse a request:
 *  `{ statusCode, message, code }` plus each extra listed for the code whose
 *  value is defined. The message is the code's template with its placeholders
 *  filled from the extras. */
export function quizWinBadgeError(
  code: QuizWinBadgeRefusalCode,
  extras?: QuizWinBadgeErrorExtras,
): HttpException {
  const { status, message } = QUIZ_WIN_BADGE_REFUSALS[code];
  const body: Record<string, unknown> = {
    statusCode: status,
    message: fillMessageTemplate(message, extras),
    code,
  };
  for (const extra of QUIZ_WIN_BADGE_REFUSAL_EXTRAS[code]) {
    const value = extras?.[extra];
    if (value !== undefined) {
      body[extra] = value;
    }
  }
  return new HttpException(body, status);
}

/** The seven moderation audit action codes of the quiz badges, written inside
 *  the action's transaction. Automatic awards at game end write no audit row. */
export const QUIZ_BADGE_AUDIT_ACTIONS = {
  attached: 'quiz_badge_attached',
  detached: 'quiz_badge_detached',
  awardedAfterGame: 'quiz_badge_awarded_after_game',
  gameWinRevoked: 'quiz_game_win_revoked',
  definitionArchived: 'quiz_badge_definition_archived',
  definitionRestored: 'quiz_badge_definition_restored',
  definitionDeleted: 'quiz_badge_definition_deleted',
} as const;

/** Per-event transaction advisory lock. Taken first in the game end listener
 *  transaction and in routes 6 (once per attached event, ids sorted ascending),
 *  8 and 10, so recording, attaching and revoking for one event never
 *  interleave. Bind the event id as `$1`. */
export const QUIZ_EVENT_BADGES_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('quiz_event_badges:' || $1))";

/** Per-member, per-badge transaction advisory lock. `awardWin` takes it before
 *  it writes a win, and `revokeGameWin` takes it before it decides whether the
 *  award row goes, so an award and a revoke of the same badge for the same
 *  member run one after the other and a live win always keeps its award row.
 *  Callers take it in badge key order (then member id order), so two
 *  transactions never wait on each other in a cycle. Bind the member id as
 *  `$1` and the badge key as `$2`. */
export const QUIZ_BADGE_AWARD_LOCK_SQL =
  "SELECT pg_advisory_xact_lock(hashtext('quiz_badge_award:' || $1 || ':' || $2))";

/** Audit note of an attach, detach or after-the-game award:
 *  `<name_en> (<definitionId>), game <n>, event <eventId>`. */
export function quizBadgeAuditNote(
  nameEn: string,
  definitionId: string,
  gameNumber: number,
  eventId: string,
): string {
  return `${nameEn} (${definitionId}), game ${gameNumber}, event ${eventId}`;
}

/** Audit note of an archive, restore or delete: `<name_en> (<definitionId>)`. */
export function quizBadgeDefinitionAuditNote(
  nameEn: string,
  definitionId: string,
): string {
  return `${nameEn} (${definitionId})`;
}
