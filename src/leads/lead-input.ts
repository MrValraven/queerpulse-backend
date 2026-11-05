/**
 * Field rules of the leads routes, as pure functions.
 *
 * The service runs these before any query, so a CHECK or unique violation
 * never reaches the driver with the row in its error text. Each function
 * answers the contract's reason code through `leadError`, in the contract's
 * check order, and no message carries the value it refused.
 */
import { HttpStatus } from '@nestjs/common';
import { isEmail, isUUID } from 'class-validator';
import type {
  CreateLeadDto,
  ListLeadsQuery,
  UpdateLeadDto,
} from './dto/leads.dto';
import { decodeLeadCursor, isRealCalendarDay } from './lead-cursor';
import type { LeadCursorPosition } from './lead-cursor';
import { leadLinkKey } from './lead-link-key';
import {
  DEFAULT_LEAD_STAGE,
  LEAD_EMAIL_MAX,
  LEAD_FOLLOW_UP_MAX,
  LEAD_FOLLOW_UP_MIN,
  LEAD_LINK_MAX,
  LEAD_LINKS_MAX,
  LEAD_LOCATION_MAX,
  LEAD_NAME_MAX,
  LEAD_NOTE_MAX,
  LEAD_PHONE_MAX,
  LEAD_SEARCH_QUERY_MAX,
  LEAD_STAGES,
  LEAD_TYPES,
  OPEN_LEAD_STAGES,
  leadError,
} from './leads.constants';
import type {
  LeadRefusalCode,
  LeadStage,
  LeadType,
  OpenLeadStage,
} from './leads.constants';

/** One kept link: the trimmed text as typed, its link key, and its place in
 *  the submitted `links` array (the index a refusal names). */
export interface NormalizedLeadLink {
  text: string;
  key: string;
  submittedIndex: number;
}

/** A create body after every field check passed. */
export interface NormalizedLeadCreate {
  name: string;
  type: LeadType;
  stage: LeadStage;
  location: string | null;
  email: string | null;
  phone: string | null;
  links: NormalizedLeadLink[];
  followUpOn: string | null;
  /** The first note, or `null` when none was given. */
  note: string | null;
}

/** An update body after every field check passed. A key is present only when
 *  the body sent that property. */
export type NormalizedLeadUpdate = Partial<
  Omit<NormalizedLeadCreate, 'note'>
> & { linkedSubprofileId?: string | null };

/** The list query after its checks. `term` is `''` for no search. */
export interface LeadListFilters {
  term: string;
  stage: LeadStage | null;
  type: LeadType | null;
  isDueOnly: boolean;
  cursor: LeadCursorPosition | null;
}

/** A UTF-16 surrogate half with no partner: a high one not followed by a
 *  low one, or a low one not preceded by a high one. */
const UNPAIRED_SURROGATE =
  /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;
const REPLACEMENT_CHARACTER = '\uFFFD';

/**
 * The storable form of a staff-typed lead text: every U+0000 is removed and
 * every unpaired UTF-16 surrogate becomes U+FFFD. Trimming and every length or
 * shape check run after it.
 *
 * Postgres refuses both inside text (22021) and inside the `links` jsonb
 * (22P05, 22P02), so either one would turn a save into a 500 whose failed
 * query carries the lead row in its parameters. Applied to the name,
 * location, email, phone, each link, both note paths, the list search term
 * and the persona picker search (`LeadPersonaService.searchPersonas`).
 * Idempotent, so a text that passes through it twice is unchanged.
 */
export function sanitizeLeadText(value: string): string {
  return value
    .replaceAll('\u0000', '')
    .replace(UNPAIRED_SURROGATE, REPLACEMENT_CHARACTER);
}

/** Whether `value` is one of `LEAD_TYPES`. */
export function isLeadType(value: unknown): value is LeadType {
  return (
    typeof value === 'string' &&
    (LEAD_TYPES as readonly string[]).includes(value)
  );
}

/** Whether `value` is one of `LEAD_STAGES`. */
export function isLeadStage(value: unknown): value is LeadStage {
  return (
    typeof value === 'string' &&
    (LEAD_STAGES as readonly string[]).includes(value)
  );
}

/** Whether `value` is a stage a follow-up can be due in. */
export function isOpenLeadStage(value: unknown): value is OpenLeadStage {
  return (
    typeof value === 'string' &&
    (OPEN_LEAD_STAGES as readonly string[]).includes(value)
  );
}

/** Whether a follow-up is due: the stage is open and the day is on or before
 *  `today`, the Lisbon calendar day. Both days are `YYYY-MM-DD`, so text
 *  order is day order. */
export function isLeadFollowUpDue(
  stage: LeadStage,
  followUpOn: string | null,
  today: string,
): boolean {
  return isOpenLeadStage(stage) && followUpOn !== null && followUpOn <= today;
}

/** Checks a create body in the contract order (name, type, stage, location,
 *  email, phone, links, follow-up, note). An absent stage takes the default;
 *  a `null` stage is refused. */
export function normalizeLeadCreate(body: CreateLeadDto): NormalizedLeadCreate {
  const name = normalizeLeadName(body.name);
  const type = normalizeLeadType(body.type);
  const stage =
    body.stage === undefined
      ? DEFAULT_LEAD_STAGE
      : normalizeLeadStage(body.stage);
  const location =
    body.location === undefined
      ? null
      : normalizeOptionalText(
          body.location,
          LEAD_LOCATION_MAX,
          'LEAD_LOCATION_TOO_LONG',
        );
  const email =
    body.email === undefined ? null : normalizeLeadEmail(body.email);
  const phone =
    body.phone === undefined
      ? null
      : normalizeOptionalText(
          body.phone,
          LEAD_PHONE_MAX,
          'LEAD_PHONE_TOO_LONG',
        );
  const links = body.links === undefined ? [] : normalizeLeadLinks(body.links);
  const followUpOn =
    body.followUpOn === undefined ? null : normalizeFollowUpOn(body.followUpOn);
  const note = normalizeFirstNote(body.note);
  return { name, type, stage, location, email, phone, links, followUpOn, note };
}

/** Checks an update body in the create order, then the persona id shape. An
 *  absent property stays out of the answer. `name`, `type` and `stage` refuse
 *  `null`; `location`, `email`, `phone`, `followUpOn` and
 *  `linkedSubprofileId` read `null` as a clear. A persona id that is no uuid
 *  string answers 400 `LEAD_PERSONA_NOT_FOUND`; a valid one is lowercased so
 *  it compares with the stored id as text. */
export function normalizeLeadUpdate(body: UpdateLeadDto): NormalizedLeadUpdate {
  const changes: NormalizedLeadUpdate = {};
  if (body.name !== undefined) changes.name = normalizeLeadName(body.name);
  if (body.type !== undefined) changes.type = normalizeLeadType(body.type);
  if (body.stage !== undefined) changes.stage = normalizeLeadStage(body.stage);
  if (body.location !== undefined) {
    changes.location = normalizeOptionalText(
      body.location,
      LEAD_LOCATION_MAX,
      'LEAD_LOCATION_TOO_LONG',
    );
  }
  if (body.email !== undefined) changes.email = normalizeLeadEmail(body.email);
  if (body.phone !== undefined) {
    changes.phone = normalizeOptionalText(
      body.phone,
      LEAD_PHONE_MAX,
      'LEAD_PHONE_TOO_LONG',
    );
  }
  if (body.links !== undefined) changes.links = normalizeLeadLinks(body.links);
  if (body.followUpOn !== undefined) {
    changes.followUpOn = normalizeFollowUpOn(body.followUpOn);
  }
  if (body.linkedSubprofileId !== undefined) {
    changes.linkedSubprofileId = normalizeLinkedSubprofileId(
      body.linkedSubprofileId,
    );
  }
  return changes;
}

/**
 * Checks a submitted `links` value entry by entry. Within one entry the order
 * is: no string (`LEAD_LINK_INVALID`), blank (dropped), unreadable as an http
 * link (`LEAD_LINK_INVALID`), over 500 code points (`LEAD_LINK_TOO_LONG`),
 * same link key as an earlier entry (dropped, the first spelling stays). Every
 * refusal names the entry's index in the submitted array; a value that is no
 * array answers `LEAD_LINK_INVALID` with `index: -1`. More than 12 kept links
 * answer `LEAD_TOO_MANY_LINKS`.
 */
export function normalizeLeadLinks(value: unknown): NormalizedLeadLink[] {
  if (!Array.isArray(value)) {
    throw leadError('LEAD_LINK_INVALID', { index: -1 });
  }
  const keptLinks: NormalizedLeadLink[] = [];
  const seenKeys = new Set<string>();
  value.forEach((entry: unknown, submittedIndex) => {
    if (typeof entry !== 'string') {
      throw leadError('LEAD_LINK_INVALID', { index: submittedIndex });
    }
    const text = sanitizeLeadText(entry).trim();
    if (!text) return;
    const key = leadLinkKey(text);
    if (key === null) {
      throw leadError('LEAD_LINK_INVALID', { index: submittedIndex });
    }
    if (codePointLength(text) > LEAD_LINK_MAX) {
      throw leadError('LEAD_LINK_TOO_LONG', { index: submittedIndex });
    }
    if (seenKeys.has(key)) return;
    seenKeys.add(key);
    keptLinks.push({ text, key, submittedIndex });
  });
  if (keptLinks.length > LEAD_LINKS_MAX) {
    throw leadError('LEAD_TOO_MANY_LINKS');
  }
  return keptLinks;
}

/** Checks a note route `body`: trimmed at both ends with inner line breaks
 *  kept. No string or blank answers `LEAD_NOTE_EMPTY`; over 4000 code points
 *  answers `LEAD_NOTE_TOO_LONG`. */
export function normalizeNoteBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw leadError('LEAD_NOTE_EMPTY');
  }
  const body = sanitizeLeadText(value).trim();
  if (!body) {
    throw leadError('LEAD_NOTE_EMPTY');
  }
  if (codePointLength(body) > LEAD_NOTE_MAX) {
    throw leadError('LEAD_NOTE_TOO_LONG');
  }
  return body;
}

/** Checks the list query in the order stage, type, cursor. A blank or absent
 *  stage or type means every one. A blank or repeated `q` is no search and a
 *  long one is cut to 100 code points. Only the exact text `true` turns the
 *  due filter on. */
export function normalizeLeadListFilters(
  query: ListLeadsQuery,
): LeadListFilters {
  const stage = normalizeStageFilter(query.stage);
  const type = normalizeTypeFilter(query.type);
  const cursor = normalizeCursorFilter(query.cursor);
  return {
    term: normalizeSearchTerm(query.q),
    stage,
    type,
    isDueOnly: query.due === 'true',
    cursor,
  };
}

function codePointLength(value: string): number {
  return Array.from(value).length;
}

function normalizeLeadName(value: unknown): string {
  if (typeof value !== 'string') {
    throw leadError('LEAD_NAME_REQUIRED');
  }
  const name = sanitizeLeadText(value).trim();
  if (!name) {
    throw leadError('LEAD_NAME_REQUIRED');
  }
  if (codePointLength(name) > LEAD_NAME_MAX) {
    throw leadError('LEAD_NAME_TOO_LONG');
  }
  return name;
}

// Contract 3.1: strings are trimmed before their checks, so `' band '` reads
// as `band`. Any other value passes through untouched and fails the guard.
function trimmedIfText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

function normalizeLeadType(value: unknown): LeadType {
  const candidate = trimmedIfText(value);
  if (!isLeadType(candidate)) {
    throw leadError('LEAD_TYPE_INVALID');
  }
  return candidate;
}

function normalizeLeadStage(value: unknown): LeadStage {
  const candidate = trimmedIfText(value);
  if (!isLeadStage(candidate)) {
    throw leadError('LEAD_STAGE_INVALID');
  }
  return candidate;
}

// Location and phone: a string or null, else the field's too-long code (the
// contract names one code per field). Blank after trim stores null.
function normalizeOptionalText(
  value: unknown,
  maxLength: number,
  code: LeadRefusalCode,
): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw leadError(code);
  }
  const text = sanitizeLeadText(value).trim();
  if (!text) return null;
  if (codePointLength(text) > maxLength) {
    throw leadError(code);
  }
  return text;
}

// The stored value is the trimmed, lowercased text, which is what the
// `CHK_leads_email` CHECK and `varchar(254)` see, so both checks read it.
function normalizeLeadEmail(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw leadError('LEAD_EMAIL_INVALID');
  }
  const email = sanitizeLeadText(value).trim().toLowerCase();
  if (!email) return null;
  if (codePointLength(email) > LEAD_EMAIL_MAX || !isEmail(email)) {
    throw leadError('LEAD_EMAIL_INVALID');
  }
  return email;
}

// Both bounds and the day are `YYYY-MM-DD`, so text order is day order.
function normalizeFollowUpOn(value: unknown): string | null {
  if (value === null) return null;
  const day = trimmedIfText(value);
  const isValid =
    typeof day === 'string' &&
    isRealCalendarDay(day) &&
    day >= LEAD_FOLLOW_UP_MIN &&
    day <= LEAD_FOLLOW_UP_MAX;
  if (!isValid) {
    throw leadError('LEAD_FOLLOW_UP_INVALID');
  }
  return day;
}

// Absent, null or blank after trim writes no first note. Any other value
// that is no string answers `LEAD_NOTE_EMPTY`.
function normalizeFirstNote(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    throw leadError('LEAD_NOTE_EMPTY');
  }
  if (!sanitizeLeadText(value).trim()) return null;
  return normalizeNoteBody(value);
}

function normalizeLinkedSubprofileId(value: unknown): string | null {
  if (value === null) return null;
  const subprofileId = trimmedIfText(value);
  if (typeof subprofileId !== 'string' || !isUUID(subprofileId)) {
    throw leadError('LEAD_PERSONA_NOT_FOUND', {
      status: HttpStatus.BAD_REQUEST,
    });
  }
  return subprofileId.toLowerCase();
}

// Trimmed first, so a blank filter reads as every stage or type.
function normalizeStageFilter(value: unknown): LeadStage | null {
  const candidate = trimmedIfText(value);
  if (candidate === undefined || candidate === '') return null;
  return normalizeLeadStage(candidate);
}

function normalizeTypeFilter(value: unknown): LeadType | null {
  const candidate = trimmedIfText(value);
  if (candidate === undefined || candidate === '') return null;
  return normalizeLeadType(candidate);
}

// A repeated `cursor` arrives as an array and answers `LEAD_CURSOR_INVALID`
// like any other cursor that fails to decode.
function normalizeCursorFilter(value: unknown): LeadCursorPosition | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    throw leadError('LEAD_CURSOR_INVALID');
  }
  return decodeLeadCursor(value);
}

function normalizeSearchTerm(value: unknown): string {
  if (typeof value !== 'string') return '';
  const trimmed = sanitizeLeadText(value).trim();
  if (!trimmed) return '';
  return Array.from(trimmed).slice(0, LEAD_SEARCH_QUERY_MAX).join('');
}
