import { HttpException, HttpStatus } from '@nestjs/common';
import type {
  PersonaWallHiddenState,
  PersonaWallPublicState,
} from '../subprofiles/persona-wall.constants';

/** What kind of act or place a lead is. */
export const LEAD_TYPES = [
  'artist',
  'dj',
  'band',
  'venue',
  'promoter',
  'collective',
  'business',
  'other',
] as const;
export type LeadType = (typeof LEAD_TYPES)[number];

/** Where a lead sits in the outreach, in board order. */
export const LEAD_STAGES = [
  'to_contact',
  'contacted',
  'in_talks',
  'on_board',
  'not_now',
] as const;
export type LeadStage = (typeof LEAD_STAGES)[number];
/** The stage a lead created with no stage starts in. */
export const DEFAULT_LEAD_STAGE: LeadStage = 'to_contact';

/** The stages a follow-up can be due in (badge and `due=true`). */
export const OPEN_LEAD_STAGES = [
  'to_contact',
  'contacted',
  'in_talks',
] as const;
export type OpenLeadStage = (typeof OPEN_LEAD_STAGES)[number];

/** Every kind of row on a lead's dated entry log. */
export const LEAD_ENTRY_KINDS = [
  'note',
  'stage_changed',
  'persona_linked',
  'persona_unlinked',
  'created',
] as const;
export type LeadEntryKind = (typeof LEAD_ENTRY_KINDS)[number];

/** Longest trimmed lead name, in code points. */
export const LEAD_NAME_MAX = 120;
/** Longest trimmed location, in code points. */
export const LEAD_LOCATION_MAX = 120;
/** Longest trimmed email address, in code points. */
export const LEAD_EMAIL_MAX = 254;
/** Longest trimmed phone number, in code points. */
export const LEAD_PHONE_MAX = 40;
/** Most links one lead keeps, after blanks and duplicates are dropped. */
export const LEAD_LINKS_MAX = 12;
/** Longest trimmed link, in code points. */
export const LEAD_LINK_MAX = 500;
/** Longest trimmed note, in code points. */
export const LEAD_NOTE_MAX = 4000;
/** Rows on one list page. */
export const LEAD_PAGE_SIZE = 50;
/** Most rows the persona search answers. */
export const LEAD_PERSONA_SEARCH_LIMIT = 20;
/** Longest list or persona search text, in code points; longer is cut. */
export const LEAD_SEARCH_QUERY_MAX = 100;
/** Links shown on a list row. */
export const LEAD_LIST_LINKS_SHOWN = 3;
/** The calendar day of a follow-up is read in this zone. */
export const LEAD_TIME_ZONE = 'Europe/Lisbon';
/** Follow-up dates outside this range answer LEAD_FOLLOW_UP_INVALID. */
export const LEAD_FOLLOW_UP_MIN = '2000-01-01';
export const LEAD_FOLLOW_UP_MAX = '2100-12-31';

/** The persona's public state, reused from the persona wall:
 *  'shown' | 'draft' | 'not_open' | 'removed' | 'taken_down'. */
export type LeadPersonaPublicState = PersonaWallPublicState;

/** A public state that keeps a persona from being linked to a lead. */
export type LeadPersonaHiddenState = PersonaWallHiddenState;

/** Every reason code a leads refusal can carry, in contract table order. */
export type LeadRefusalCode =
  | 'LEAD_NOT_FOUND'
  | 'LEAD_NAME_REQUIRED'
  | 'LEAD_NAME_TOO_LONG'
  | 'LEAD_TYPE_INVALID'
  | 'LEAD_STAGE_INVALID'
  | 'LEAD_LOCATION_TOO_LONG'
  | 'LEAD_EMAIL_INVALID'
  | 'LEAD_EMAIL_TAKEN'
  | 'LEAD_PHONE_TOO_LONG'
  | 'LEAD_LINK_INVALID'
  | 'LEAD_LINK_TOO_LONG'
  | 'LEAD_TOO_MANY_LINKS'
  | 'LEAD_LINK_TAKEN'
  | 'LEAD_FOLLOW_UP_INVALID'
  | 'LEAD_PERSONA_NOT_FOUND'
  | 'LEAD_PERSONA_NOT_LISTED'
  | 'LEAD_PERSONA_TAKEN'
  | 'LEAD_NOTE_EMPTY'
  | 'LEAD_NOTE_TOO_LONG'
  | 'LEAD_NOTE_NOT_FOUND'
  | 'LEAD_NOTE_NOT_YOURS'
  | 'LEAD_ENTRY_NOT_EDITABLE'
  | 'LEAD_CURSOR_INVALID';

/** Status and fixed message of every refusal the leads routes answer with.
 *  No message interpolates a lead's name, email, phone, link or note text. */
export const LEAD_REFUSALS: Record<
  LeadRefusalCode,
  { status: HttpStatus; message: string }
> = {
  LEAD_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No lead has this id.',
  },
  LEAD_NAME_REQUIRED: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A lead needs a name.',
  },
  LEAD_NAME_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A lead name can be at most ${LEAD_NAME_MAX} characters.`,
  },
  LEAD_TYPE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The type must be artist, dj, band, venue, promoter, collective, business or other.',
  },
  LEAD_STAGE_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The stage must be to_contact, contacted, in_talks, on_board or not_now.',
  },
  LEAD_LOCATION_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A location can be at most ${LEAD_LOCATION_MAX} characters.`,
  },
  LEAD_EMAIL_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The email address is malformed.',
  },
  LEAD_EMAIL_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'Another lead already has this email address.',
  },
  LEAD_PHONE_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A phone number can be at most ${LEAD_PHONE_MAX} characters.`,
  },
  LEAD_LINK_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'Each link must be a full http or https address.',
  },
  LEAD_LINK_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A link can be at most ${LEAD_LINK_MAX} characters.`,
  },
  LEAD_TOO_MANY_LINKS: {
    status: HttpStatus.BAD_REQUEST,
    message: `A lead can have at most ${LEAD_LINKS_MAX} links.`,
  },
  LEAD_LINK_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'Another lead already has this link.',
  },
  LEAD_FOLLOW_UP_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message:
      'The follow-up date must be a real day from 2000-01-01 to 2100-12-31.',
  },
  LEAD_PERSONA_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'No persona has this id.',
  },
  LEAD_PERSONA_NOT_LISTED: {
    status: HttpStatus.CONFLICT,
    message:
      "This persona is hidden from the People Directory, so it can't be linked to a lead.",
  },
  LEAD_PERSONA_TAKEN: {
    status: HttpStatus.CONFLICT,
    message: 'This persona is already linked to another lead.',
  },
  LEAD_NOTE_EMPTY: {
    status: HttpStatus.BAD_REQUEST,
    message: 'A note needs some text.',
  },
  LEAD_NOTE_TOO_LONG: {
    status: HttpStatus.BAD_REQUEST,
    message: `A note can be at most ${LEAD_NOTE_MAX} characters.`,
  },
  LEAD_NOTE_NOT_FOUND: {
    status: HttpStatus.NOT_FOUND,
    message: 'This note is no longer on the lead.',
  },
  LEAD_NOTE_NOT_YOURS: {
    status: HttpStatus.FORBIDDEN,
    message: 'Only the author of this note or an Admin can change it.',
  },
  LEAD_ENTRY_NOT_EDITABLE: {
    status: HttpStatus.CONFLICT,
    message:
      'Only notes can be edited or deleted. Stage, persona and creation entries stay as the record.',
  },
  LEAD_CURSOR_INVALID: {
    status: HttpStatus.BAD_REQUEST,
    message: 'The list cursor is malformed. Load the list again from the top.',
  },
};

/** What LEAD_PERSONA_NOT_LISTED says for each state that hides a persona. */
export const LEAD_PERSONA_NOT_LISTED_MESSAGES: Record<
  LeadPersonaHiddenState,
  string
> = {
  draft: "This persona is a draft, so it can't be linked to a lead.",
  not_open: "This persona is not public, so it can't be linked to a lead.",
  removed: "This persona was removed, so it can't be linked to a lead.",
  taken_down:
    "This persona was taken down by a moderator, so it can't be linked to a lead.",
};

/** A body field a refusal may carry beside `statusCode`, `message` and `code`. */
export type LeadRefusalExtra = 'leadId' | 'leadName' | 'index' | 'publicState';

/** The extra body fields each code carries. `leadError` copies only these
 *  from its options, so a stray option never reaches a body. */
export const LEAD_REFUSAL_EXTRAS: Record<
  LeadRefusalCode,
  readonly LeadRefusalExtra[]
> = {
  LEAD_NOT_FOUND: [],
  LEAD_NAME_REQUIRED: [],
  LEAD_NAME_TOO_LONG: [],
  LEAD_TYPE_INVALID: [],
  LEAD_STAGE_INVALID: [],
  LEAD_LOCATION_TOO_LONG: [],
  LEAD_EMAIL_INVALID: [],
  LEAD_EMAIL_TAKEN: ['leadId', 'leadName'],
  LEAD_PHONE_TOO_LONG: [],
  LEAD_LINK_INVALID: ['index'],
  LEAD_LINK_TOO_LONG: ['index'],
  LEAD_TOO_MANY_LINKS: [],
  LEAD_LINK_TAKEN: ['leadId', 'leadName', 'index'],
  LEAD_FOLLOW_UP_INVALID: [],
  LEAD_PERSONA_NOT_FOUND: [],
  LEAD_PERSONA_NOT_LISTED: ['publicState'],
  LEAD_PERSONA_TAKEN: ['leadId', 'leadName'],
  LEAD_NOTE_EMPTY: [],
  LEAD_NOTE_TOO_LONG: [],
  LEAD_NOTE_NOT_FOUND: [],
  LEAD_NOTE_NOT_YOURS: [],
  LEAD_ENTRY_NOT_EDITABLE: [],
  LEAD_CURSOR_INVALID: [],
};

/** What a caller may hand `leadError`. `status` overrides the table's status
 *  (a malformed persona id answers 400); the rest are body extras. */
export interface LeadErrorOptions {
  status?: HttpStatus;
  leadId?: string;
  leadName?: string;
  index?: number;
  publicState?: LeadPersonaHiddenState;
}

/** The one way the leads routes refuse a request:
 *  `{ statusCode, message, code }` plus each extra listed for the code in
 *  `LEAD_REFUSAL_EXTRAS` whose option is defined. LEAD_PERSONA_NOT_LISTED
 *  swaps in the message that names the state when `publicState` is given.
 *  The message is always a fixed sentence from the tables above. */
export function leadError(
  code: LeadRefusalCode,
  options?: LeadErrorOptions,
): HttpException {
  const refusal = LEAD_REFUSALS[code];
  const status = options?.status ?? refusal.status;
  const publicState = options?.publicState;
  const message =
    code === 'LEAD_PERSONA_NOT_LISTED' && publicState !== undefined
      ? LEAD_PERSONA_NOT_LISTED_MESSAGES[publicState]
      : refusal.message;
  const body: Record<string, unknown> = { statusCode: status, message, code };
  for (const extra of LEAD_REFUSAL_EXTRAS[code]) {
    const value = options?.[extra];
    if (value !== undefined) {
      body[extra] = value;
    }
  }
  return new HttpException(body, status);
}
