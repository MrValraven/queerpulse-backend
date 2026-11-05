import { HttpException, HttpStatus } from '@nestjs/common';

/** The wall holds at most this many hand-picked personas. */
export const PERSONA_WALL_MAX_PICKS = 9;

/** Most rows the admin persona search answers. */
export const PERSONA_WALL_SEARCH_LIMIT = 20;

/** How the rest of the wall fills after the picks. */
export const PERSONA_WALL_FILL_ORDERS = [
  'endorsed',
  'followed',
  'newest',
  'daily_shuffle',
] as const;
export type PersonaWallFillOrder = (typeof PERSONA_WALL_FILL_ORDERS)[number];
export const DEFAULT_PERSONA_WALL_FILL_ORDER: PersonaWallFillOrder = 'endorsed';

/** Why a persona does or does not show on the wall. The first matching
 *  reason, in the order removed, taken_down, draft, not_open, wins. */
export type PersonaWallPublicState =
  'shown' | 'draft' | 'not_open' | 'removed' | 'taken_down';

/** Longest admin search text, counted in code points. The service cuts a
 *  longer `q` to this many, so the answer is always a list. */
export const PERSONA_WALL_SEARCH_QUERY_MAX = 100;

/** The day of a daily shuffle is read in this time zone. */
export const PERSONA_WALL_TIME_ZONE = 'Europe/Lisbon';

/** The one row of `persona_wall_settings`. */
export const PERSONA_WALL_SETTINGS_ID = 1;

/** The deferrable unique constraint on `persona_wall_picks.position`.
 *  A reorder or a remove rewrites positions under `SET CONSTRAINTS ... DEFERRED`. */
export const PERSONA_WALL_POSITION_CONSTRAINT =
  'UQ_persona_wall_picks_position';

/** Whether a wall tile was hand-picked or filled in by the fill order. */
export type PersonaWallSource = 'picked' | 'filled';

/** A public state that keeps a persona off the wall. */
export type PersonaWallHiddenState = Exclude<PersonaWallPublicState, 'shown'>;

/** Every reason code a persona wall refusal can carry. */
export type PersonaWallRefusalCode =
  | 'PERSONA_WALL_FULL'
  | 'PERSONA_WALL_ALREADY_PICKED'
  | 'PERSONA_WALL_PERSONA_NOT_FOUND'
  | 'PERSONA_WALL_NOT_LISTED'
  | 'PERSONA_WALL_PICK_NOT_FOUND'
  | 'PERSONA_WALL_REORDER_MISMATCH'
  | 'PERSONA_WALL_INVALID_FILL_ORDER';

/** Status and message of every refusal the wall routes answer with. */
export const PERSONA_WALL_REFUSALS: Record<
  PersonaWallRefusalCode,
  { status: HttpStatus; message: string }
> = {
  PERSONA_WALL_FULL: {
    status: HttpStatus.CONFLICT,
    message: `The wall already has ${PERSONA_WALL_MAX_PICKS} personas. Remove one to add another.`,
  },
  PERSONA_WALL_ALREADY_PICKED: {
    status: HttpStatus.CONFLICT,
    message: 'This persona is already on the wall.',
  },
  PERSONA_WALL_PERSONA_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No persona has this id.',
  },
  PERSONA_WALL_NOT_LISTED: {
    status: HttpStatus.CONFLICT,
    message:
      "This persona is hidden from the People Directory, so it can't go on the wall.",
  },
  PERSONA_WALL_PICK_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'This pick is no longer on the wall.',
  },
  PERSONA_WALL_REORDER_MISMATCH: {
    status: HttpStatus.CONFLICT,
    message:
      'The wall changed since it was loaded. Reload it and reorder again.',
  },
  PERSONA_WALL_INVALID_FILL_ORDER: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The fill order must be endorsed, followed, newest or daily_shuffle.',
  },
};

/** What PERSONA_WALL_NOT_LISTED says for each state that hides a persona. */
export const PERSONA_WALL_NOT_LISTED_MESSAGES: Record<
  PersonaWallHiddenState,
  string
> = {
  draft: "This persona is a draft, so it can't go on the wall.",
  not_open: "This persona is not public, so it can't go on the wall.",
  removed: "This persona was removed, so it can't go on the wall.",
  taken_down:
    "This persona was taken down by a moderator, so it can't go on the wall.",
};

/** The one way the wall routes refuse a request:
 *  `{ statusCode, message, code }`. PERSONA_WALL_NOT_LISTED also carries
 *  `publicState` and a message that names it, when `publicState` is given.
 *  `status` overrides the table's status (a malformed persona id answers 400). */
export function personaWallError(
  code: PersonaWallRefusalCode,
  options?: { status?: HttpStatus; publicState?: PersonaWallHiddenState },
): HttpException {
  const refusal = PERSONA_WALL_REFUSALS[code];
  const status = options?.status ?? refusal.status;
  const publicState = options?.publicState;
  if (code === 'PERSONA_WALL_NOT_LISTED' && publicState !== undefined) {
    return new HttpException(
      {
        statusCode: status,
        message: PERSONA_WALL_NOT_LISTED_MESSAGES[publicState],
        code,
        publicState,
      },
      status,
    );
  }
  return new HttpException(
    { statusCode: status, message: refusal.message, code },
    status,
  );
}
