import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
} from '@nestjs/common';

/**
 * Funding & Grants: every rule about open calls (`kind: 'call'`) and
 * fundraisers (`kind: 'ask'`) that needs no database.
 *
 * Pure and I/O free, so the service, the response mapper, the list views and
 * the reminder sweeper all read one definition. The frontend mirrors the
 * allow-list, `PT_MOBILE_PATTERN` and the IBAN rules (separators,
 * `IBAN_LENGTH_BY_COUNTRY`, the BBAN digit floor, mod-97 checksum) from this
 * file, which is authoritative for all three.
 */

/** The forum category every call, ask and funding discussion lives in. */
export const FUNDING_CATEGORY = 'funding';

export const FUNDING_KINDS = ['call', 'ask'] as const;
export type FundingKind = (typeof FUNDING_KINDS)[number];

export const FUNDING_ELIGIBILITIES = [
  'individuals',
  'collectives',
  'associations',
  'companies',
  'students',
] as const;
export type FundingEligibility = (typeof FUNDING_ELIGIBILITIES)[number];

export const FUNDING_SCOPES = [
  'local',
  'national',
  'eu',
  'international',
] as const;
export type FundingScope = (typeof FUNDING_SCOPES)[number];

export const ASK_PURPOSES = [
  'healthcare',
  'housing',
  'legal',
  'emergency',
  'project',
  'event',
] as const;
export type AskPurpose = (typeof ASK_PURPOSES)[number];

export const ASK_BENEFICIARIES = ['self', 'someone_i_know', 'project'] as const;
export type AskBeneficiary = (typeof ASK_BENEFICIARIES)[number];

export const ASK_ENDED_REASONS = ['goal_reached', 'closed'] as const;
export type AskEndedReason = (typeof ASK_ENDED_REASONS)[number];

/** `GET /forum/threads?fundingView=`, honoured only with `category=funding`. */
export const FUNDING_VIEWS = ['open', 'closing', 'asks', 'discussion'] as const;
export type FundingView = (typeof FUNDING_VIEWS)[number];

/** The funding half of a thread-list request (`ForumThreadsService.list`). */
export interface FundingListFilter {
  view?: FundingView;
  eligibility?: FundingEligibility[];
  scope?: FundingScope;
}

/**
 * The crowdfunding hosts a fundraiser may link to. A host matches when it
 * equals an entry or `www.` plus an entry, and in no other way: a suffix, a
 * prefix, a subdomain or a homograph all fail. Identical in the frontend.
 */
export const FUNDING_LINK_HOST_ALLOW_LIST: readonly string[] = [
  'ppl.pt',
  'gofundme.com',
  'opencollective.com',
  'ko-fi.com',
  'patreon.com',
  'liberapay.com',
];

/**
 * Server-owned tag: added to every open call and stripped from every other
 * thread, so the seeded "Open funding calls" topic (keyed on this tag) lists
 * calls and only calls.
 */
export const OPEN_CALL_TAG = 'open-call';

const DAY_MS = 24 * 60 * 60 * 1000;
/** A call whose deadline falls within this window reads `closing`. */
export const CALL_CLOSING_WINDOW_MS = 7 * DAY_MS;
/** A rolling call nobody has touched for this long reads `stale`. */
export const ROLLING_CALL_STALE_MS = 183 * DAY_MS;
/** An approved ask with no end date ends this long after approval. */
export const ASK_AUTO_END_MS = 90 * DAY_MS;
const MAX_CALL_DEADLINE_AHEAD_MS = 2 * 365 * DAY_MS;
const MAX_ASK_RUN_MS = 365 * DAY_MS;

export const MAX_FUNDING_LINK_URL_LENGTH = 2048;
export const MAX_FUNDING_LINK_KEY_LENGTH = 512;
export const MAX_FUNDER_NAME_LENGTH = 120;
/** Whole euros. Large enough for any EU programme, small enough for `integer`. */
export const MAX_FUNDING_AMOUNT = 100_000_000;
export const MAX_ASK_GOAL_AMOUNT = 10_000_000;

export type FundingErrorCode =
  | 'funding_kind_category_mismatch'
  | 'funding_details_required'
  | 'funding_details_not_allowed'
  | 'funding_link_invalid'
  | 'funding_link_host_not_allowed'
  | 'funding_payment_details_in_body'
  | 'funding_ask_not_anonymous'
  | 'funding_ask_verification_required'
  | 'funding_ask_limit_reached';

const FUNDING_ERRORS: Record<
  FundingErrorCode,
  { status: 400 | 403 | 409; message: string }
> = {
  funding_kind_category_mismatch: {
    status: 400,
    message: 'Open calls and fundraisers live in the funding category',
  },
  funding_details_required: {
    status: 400,
    message: 'This post needs its funding details',
  },
  funding_details_not_allowed: {
    status: 400,
    message: 'Funding details belong on an open call or a fundraiser',
  },
  funding_link_invalid: {
    status: 400,
    message: 'The link must be a full https address',
  },
  funding_link_host_not_allowed: {
    status: 400,
    message: 'Fundraisers must link to a supported crowdfunding site',
  },
  funding_payment_details_in_body: {
    status: 400,
    message:
      'Take out bank and phone payment details: donations go through the crowdfunding link',
  },
  funding_ask_not_anonymous: {
    status: 400,
    message: 'Fundraisers are posted under your own name',
  },
  funding_ask_verification_required: {
    status: 403,
    message: 'Fundraisers need a verified phone',
  },
  funding_ask_limit_reached: {
    status: 409,
    message: 'You already have a fundraiser open or waiting for review',
  },
};

/**
 * THE way a funding rule refuses a request: the affirming-pledge body
 * `{ statusCode, error, message, code }`, so the composer maps `code` to its
 * own copy and shows `message` only as a fallback.
 */
export function fundingException(
  code: FundingErrorCode,
  message?: string,
): HttpException {
  const definition = FUNDING_ERRORS[code];
  const resolvedMessage = message ?? definition.message;
  if (definition.status === 403) {
    return new ForbiddenException({
      statusCode: 403,
      error: 'Forbidden',
      message: resolvedMessage,
      code,
    });
  }
  if (definition.status === 409) {
    return new ConflictException({
      statusCode: 409,
      error: 'Conflict',
      message: resolvedMessage,
      code,
    });
  }
  return new BadRequestException({
    statusCode: 400,
    error: 'Bad Request',
    message: resolvedMessage,
    code,
  });
}

export function isFundingKind(
  kind: string | null | undefined,
): kind is FundingKind {
  return kind === 'call' || kind === 'ask';
}

/**
 * Exact match on purpose. `category` is stored as sent and every funding view
 * filters `t.category = 'funding'` exactly, so a padded or capitalised value
 * accepted here would store a call or an ask that no funding view lists.
 * Comparing strictly makes the create, move and list decisions agree with
 * the stored column, and the composer always sends the canonical value.
 */
export function isFundingCategory(category: string): boolean {
  return category === FUNDING_CATEGORY;
}

function includesValue<Value extends string>(
  values: readonly Value[],
  candidate: unknown,
): candidate is Value {
  return (
    typeof candidate === 'string' &&
    (values as readonly string[]).includes(candidate)
  );
}

/**
 * A lowercased hostname with one leading `www.` removed: THE spelling of a
 * funding link's host, shared by `normalizeFundingLink`, the card's
 * `linkHost` (`forum-response.ts`) and the review queue's facts.
 */
export function stripLeadingWww(hostname: string): string {
  return hostname.startsWith('www.') ? hostname.slice(4) : hostname;
}

export interface NormalizedFundingLink {
  /** The parsed, re-serialised URL that is stored and rendered. */
  linkUrl: string;
  /** Lowercased host with one leading `www.` removed. */
  linkHost: string;
  /**
   * `linkHost` plus the path with trailing slashes removed, plus the
   * non-tracking query parameters sorted by name; the fragment is dropped.
   */
  linkKey: string;
}

const TRACKING_PARAMETER_NAMES = ['fbclid', 'gclid', 'igshid', 'ref'];

/** Plain code-point order, so a key never depends on the server's ICU locale. */
function compareCodePoints(first: string, second: string): number {
  if (first < second) return -1;
  return first > second ? 1 : 0;
}

function isTrackingParameter(name: string): boolean {
  const lowered = name.toLowerCase();
  return (
    lowered.startsWith('utm_') ||
    lowered.startsWith('mc_') ||
    TRACKING_PARAMETER_NAMES.includes(lowered)
  );
}

/**
 * Parses a member-typed link. Answers null for anything that is not a plain
 * https URL on a dotted host: other schemes, a credential prefix
 * (`https://gofundme.com@evil.io/` really points at `evil.io`), a bare
 * hostname, an empty host label (`https://www./x`), or a key too long for its
 * column. Tracking parameters never reach the key, so one call has one key
 * whatever campaign link it was shared through; a parameter that selects the
 * page (`?id=123`) stays in it.
 *
 * `URL` already lowercases the host and converts an internationalised one to
 * punycode, so a homograph can never compare equal to an allow-list entry.
 */
export function normalizeFundingLink(
  raw: string,
): NormalizedFundingLink | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_FUNDING_LINK_URL_LENGTH) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  const hostname = parsed.hostname.toLowerCase();
  if (!hostname.includes('.')) return null;
  if (hostname.split('.').some((label) => label === '')) return null;
  const linkHost = stripLeadingWww(hostname);
  const path = parsed.pathname.replace(/\/+$/, '');
  const keptParameters = [...parsed.searchParams.entries()]
    .filter(([name]) => !isTrackingParameter(name))
    .sort(([nameA, valueA], [nameB, valueB]) =>
      nameA === nameB
        ? compareCodePoints(valueA, valueB)
        : compareCodePoints(nameA, nameB),
    );
  const query =
    keptParameters.length > 0
      ? `?${new URLSearchParams(keptParameters).toString()}`
      : '';
  const linkKey = `${linkHost}${path}${query}`;
  if (linkKey.length > MAX_FUNDING_LINK_KEY_LENGTH) return null;
  // Percent-encoding can grow a short input past the column.
  if (parsed.href.length > MAX_FUNDING_LINK_URL_LENGTH) return null;
  return { linkUrl: parsed.href, linkHost, linkKey };
}

export function isAllowListedFundingHost(linkHost: string): boolean {
  return FUNDING_LINK_HOST_ALLOW_LIST.includes(linkHost);
}

/**
 * The IBAN length of every country in the ISO 13616 registry (SWIFT, release
 * of 2025), keyed by the ISO 3166 code an IBAN opens with. Territories that
 * borrow a parent's code (French overseas departments, Jersey, Guernsey, the
 * Isle of Man, \u00C5land) write the parent's code and length. A candidate is
 * tested at exactly its country's length, and a code missing here is no IBAN
 * at all, which keeps "PT2030 1000 2024 150 30 month" and "Covid19 grants"
 * out of the payment-details rule. The frontend mirrors this table verbatim.
 */
export const IBAN_LENGTH_BY_COUNTRY: Readonly<Record<string, number>> = {
  AD: 24,
  AE: 23,
  AL: 28,
  AT: 20,
  AZ: 28,
  BA: 20,
  BE: 16,
  BG: 22,
  BH: 22,
  BI: 27,
  BR: 29,
  BY: 28,
  CH: 21,
  CR: 22,
  CY: 28,
  CZ: 24,
  DE: 22,
  DJ: 27,
  DK: 18,
  DO: 28,
  EE: 20,
  EG: 29,
  ES: 24,
  FI: 18,
  FK: 18,
  FO: 18,
  FR: 27,
  GB: 22,
  GE: 22,
  GI: 23,
  GL: 18,
  GR: 27,
  GT: 28,
  HN: 28,
  HR: 21,
  HU: 28,
  IE: 22,
  IL: 23,
  IQ: 23,
  IS: 26,
  IT: 27,
  JO: 30,
  KW: 30,
  KZ: 20,
  LB: 28,
  LC: 32,
  LI: 21,
  LT: 20,
  LU: 20,
  LV: 21,
  LY: 25,
  MC: 27,
  MD: 24,
  ME: 22,
  MK: 19,
  MN: 20,
  MR: 27,
  MT: 31,
  MU: 30,
  NI: 28,
  NL: 18,
  NO: 15,
  OM: 23,
  PK: 24,
  PL: 28,
  PS: 29,
  PT: 25,
  QA: 29,
  RO: 24,
  RS: 22,
  RU: 33,
  SA: 24,
  SC: 31,
  SD: 18,
  SE: 24,
  SI: 19,
  SK: 24,
  SM: 27,
  SO: 23,
  ST: 25,
  SV: 28,
  TL: 23,
  TN: 24,
  TR: 26,
  UA: 29,
  VA: 22,
  VG: 24,
  XK: 20,
  YE: 30,
};

// An IBAN candidate: two letters (any case) and two check digits written
// solid, then 11 to 30 more characters, each optionally preceded by up to
// three separators (space, NBSP, narrow NBSP, dot or dash), because people
// write IBANs in groups and in many ways. A preceding digit blocks a start;
// a preceding letter does not, so "IBANpt50..." glued to a label still matches.
// The zero-width lookahead capture lets every start position be tried, so an
// earlier look-alike ("PT2030", "AB12") never masks a real IBAN after it.
const IBAN_CANDIDATE_PATTERN =
  /(?<![0-9])(?=([A-Za-z]{2}\d{2}(?:[ \u00A0\u202F.-]{0,3}[A-Za-z0-9]){11,30}))/g;
// The part after the country code and check digits must hold this many digits;
// prose such as "PT2030 printing queer share" can satisfy mod-97 by chance.
const MIN_IBAN_BBAN_DIGITS = 8;
const ALPHANUMERIC_PATTERN = /[A-Za-z0-9]/;
/**
 * A Portuguese mobile (91, 92, 93 or 96), with or without +351 / 00351,
 * written solid or grouped 3-3-3, 2-3-4 or 2-3-2-2, with up to three spaces,
 * dashes or dots between groups ("912  345  678" included). The lookbehind
 * replaces `\b`, which cannot sit between "+351" and "9". Landlines (2x) and
 * a longer digit run ("1912345678") stay out. The frontend mirrors this
 * pattern verbatim.
 */
export const PT_MOBILE_PATTERN =
  /(?:(?:\+|00)351[\s.-]{0,3}|(?<!\d))9[1236](?:\d[\s.-]{0,3}\d{3}[\s.-]{0,3}\d{3}|[\s.-]{0,3}\d{3}[\s.-]{0,3}\d{4}|[\s.-]{0,3}\d{3}[\s.-]{0,3}\d{2}[\s.-]{0,3}\d{2})(?!\d)/;

/**
 * ISO 7064 mod-97 over a separator-free IBAN: move the first four characters
 * to the end, read letters as A=10..Z=35, and the remainder must be 1.
 *
 * One of three tests `containsIban` applies to a candidate. A random string
 * passes mod-97 about once in 97 tries, which is too often for prose, so the
 * candidate must also be exactly its country's `IBAN_LENGTH_BY_COUNTRY`
 * length and hold at least `MIN_IBAN_BBAN_DIGITS` digits after the country
 * code and check digits.
 */
function hasValidIbanChecksum(compact: string): boolean {
  const rearranged = compact.slice(4) + compact.slice(0, 4);
  let remainder = 0;
  for (const character of rearranged) {
    const digits = /\d/.test(character)
      ? character
      : String(character.toUpperCase().charCodeAt(0) - 55);
    for (const digit of digits) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }
  return remainder === 1;
}

/**
 * Whether `text` holds an IBAN: a candidate whose country is in the registry,
 * read at exactly that country's length, ending on a word boundary, with the
 * BBAN digit floor met and a valid mod-97 checksum.
 */
function containsIban(text: string): boolean {
  for (const match of text.matchAll(IBAN_CANDIDATE_PATTERN)) {
    const candidate = match[1] ?? '';
    const countryCode = candidate.slice(0, 2).toUpperCase();
    const ibanLength = IBAN_LENGTH_BY_COUNTRY[countryCode];
    if (ibanLength === undefined) continue;
    const characterPositions: number[] = [];
    for (let offset = 0; offset < candidate.length; offset += 1) {
      if (ALPHANUMERIC_PATTERN.test(candidate.charAt(offset))) {
        characterPositions.push(match.index + offset);
      }
    }
    const lastPosition = characterPositions[ibanLength - 1];
    if (lastPosition === undefined) continue;
    const nextCharacter = text.charAt(lastPosition + 1);
    const isAtBoundary =
      nextCharacter === '' || !ALPHANUMERIC_PATTERN.test(nextCharacter);
    if (!isAtBoundary) continue;
    const compact = characterPositions
      .slice(0, ibanLength)
      .map((position) => text.charAt(position))
      .join('');
    const basicAccountNumber = compact.slice(4);
    const digitCount = basicAccountNumber.replace(/\D/g, '').length;
    if (digitCount >= MIN_IBAN_BBAN_DIGITS && hasValidIbanChecksum(compact)) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a fundraiser's title or body carries an IBAN or a Portuguese mobile
 * number. QueerPulse never handles money, so an ask must send donors to its
 * allow-listed crowdfunding link and nowhere else.
 */
export function containsPaymentDetails(text: string): boolean {
  return PT_MOBILE_PATTERN.test(text) || containsIban(text);
}

export type CallState = 'open' | 'closing' | 'closed' | 'stale';

/** Read-time state of an open call (wire contract "State rules"). */
export function deriveCallState(
  deadline: Date | null,
  updatedAt: Date,
  now: Date,
): CallState {
  if (deadline === null) {
    return now.getTime() - updatedAt.getTime() > ROLLING_CALL_STALE_MS
      ? 'stale'
      : 'open';
  }
  if (deadline.getTime() < now.getTime()) return 'closed';
  if (deadline.getTime() <= now.getTime() + CALL_CLOSING_WINDOW_MS) {
    return 'closing';
  }
  return 'open';
}

export type AskState = 'pending' | 'active' | 'ended';

export interface AskStateInput {
  /** `forum_thread.review_state`. */
  reviewState: string | null;
  /** False once the author erased their account (`author_id` is NULL). */
  hasAuthor: boolean;
  endedAt: Date | null;
  endsAt: Date | null;
  approvedAt: Date | null;
}

/**
 * Read-time state of a fundraiser. An author's own "ended" wins first, so a
 * pending ask its author closed never goes live on approval; anything short of
 * an approval is pending; an ask whose author erased their account has nobody
 * accountable behind its donate link, so it reads ended.
 */
export function deriveAskState(input: AskStateInput, now: Date): AskState {
  if (input.endedAt !== null) return 'ended';
  if (input.reviewState !== 'approved') return 'pending';
  if (!input.hasAuthor) return 'ended';
  if (input.endsAt !== null) {
    return input.endsAt.getTime() < now.getTime() ? 'ended' : 'active';
  }
  if (
    input.approvedAt !== null &&
    now.getTime() - input.approvedAt.getTime() > ASK_AUTO_END_MS
  ) {
    return 'ended';
  }
  return 'active';
}

/** The `funding` object as it arrives (the DTO is structurally this). */
export interface FundingInput {
  linkUrl?: string | null;
  funderName?: string | null;
  amountMin?: number | null;
  amountMax?: number | null;
  deadline?: string | null;
  eligibility?: readonly string[] | null;
  scope?: string | null;
  goalAmount?: number | null;
  askPurpose?: string | null;
  beneficiary?: string | null;
  endsAt?: string | null;
}

/** A validated funding object, with the other kind's fields nulled. */
export interface ResolvedFundingFields {
  kind: FundingKind;
  linkUrl: string;
  linkHost: string;
  linkKey: string;
  funderName: string | null;
  amountMin: number | null;
  amountMax: number | null;
  deadline: Date | null;
  eligibility: FundingEligibility[];
  scope: FundingScope | null;
  goalAmount: number | null;
  askPurpose: AskPurpose | null;
  beneficiary: AskBeneficiary | null;
  endsAt: Date | null;
}

export interface FundingValidationContext {
  now: Date;
  /** The stored deadline on an edit. An unchanged one may already have passed. */
  previousDeadline?: Date | null;
  /** The stored ask end date on an edit, same rule. */
  previousEndsAt?: Date | null;
}

interface FundingValidationFailure {
  ok: false;
  code: FundingErrorCode;
  message: string;
}

export type FundingValidationResult =
  { ok: true; value: ResolvedFundingFields } | FundingValidationFailure;

function failure(
  code: FundingErrorCode,
  message: string,
): FundingValidationFailure {
  return { ok: false, code, message };
}

function isWholeEuros(
  value: unknown,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

export const OFFSET_INSTANT_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/;

const INSTANT_SHAPE_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(.*)$/;

/** Message for a value that is not a real date and time. Starts with the
 * property name so Nest's "funding." prefix reads naturally. */
export function fundingInstantShapeMessage(field: string): string {
  return `${field} must be a date and time like 2026-12-01T23:59:00Z or 2026-12-01T23:59:00+01:00`;
}

/** Message for a real date and time that carries no Z or +HH:MM offset. */
export function fundingInstantTimeZoneMessage(field: string): string {
  return `${field} needs a time zone, like 2026-12-01T23:59:00Z`;
}

/**
 * Returns the message for the FIRST problem with an instant string, or null
 * when it is a valid offset-carrying ISO-8601 date-time. Order: shape and
 * calendar validity first (garbage, rollover such as 2026-02-30, compact
 * "+0100", lowercase "z", more than 3 fraction digits), then the missing
 * time zone.
 */
export function describeFundingInstantProblem(
  value: string,
  field: string,
): string | null {
  const match = INSTANT_SHAPE_PATTERN.exec(value);
  if (!match) return fundingInstantShapeMessage(field);
  const [, year, month, day, hour, minute, second = '0', zone] = match;
  const calendar = new Date(
    Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
    ),
  );
  const isRealCalendarTime =
    calendar.getUTCFullYear() === Number(year) &&
    calendar.getUTCMonth() === Number(month) - 1 &&
    calendar.getUTCDate() === Number(day) &&
    calendar.getUTCHours() === Number(hour) &&
    calendar.getUTCMinutes() === Number(minute) &&
    calendar.getUTCSeconds() === Number(second);
  if (!isRealCalendarTime) return fundingInstantShapeMessage(field);
  if (zone === '') return fundingInstantTimeZoneMessage(field);
  if (
    !OFFSET_INSTANT_PATTERN.test(value) ||
    Number.isNaN(new Date(value).getTime())
  ) {
    return fundingInstantShapeMessage(field);
  }
  return null;
}

function parseFutureInstant(
  value: string | null | undefined,
  field: string,
  previous: Date | null | undefined,
  now: Date,
  maximumAheadMs: number,
): { ok: true; value: Date | null } | FundingValidationFailure {
  if (value === undefined || value === null) return { ok: true, value: null };
  const problem =
    typeof value === 'string'
      ? describeFundingInstantProblem(value, field)
      : fundingInstantShapeMessage(field);
  if (problem !== null) return failure('funding_details_required', problem);
  const instant = new Date(value);
  const isUnchanged =
    previous !== undefined &&
    previous !== null &&
    previous.getTime() === instant.getTime();
  if (isUnchanged) return { ok: true, value: instant };
  if (instant.getTime() <= now.getTime()) {
    return failure(
      'funding_details_required',
      `${field} must be in the future`,
    );
  }
  if (instant.getTime() - now.getTime() > maximumAheadMs) {
    return failure('funding_details_required', `${field} is too far ahead`);
  }
  return { ok: true, value: instant };
}

function validateCallFields(
  link: NormalizedFundingLink,
  input: FundingInput,
  context: FundingValidationContext,
): FundingValidationResult {
  const funderName = input.funderName?.trim() ?? '';
  if (!funderName || funderName.length > MAX_FUNDER_NAME_LENGTH) {
    return failure(
      'funding_details_required',
      'funderName is required for an open call (1 to 120 characters)',
    );
  }
  const scope = input.scope;
  if (!includesValue(FUNDING_SCOPES, scope)) {
    return failure(
      'funding_details_required',
      'scope is required for an open call',
    );
  }
  const amountMin = input.amountMin ?? null;
  const amountMax = input.amountMax ?? null;
  if (amountMin !== null && !isWholeEuros(amountMin, 0, MAX_FUNDING_AMOUNT)) {
    return failure('funding_details_required', 'amountMin must be whole euros');
  }
  if (amountMax !== null && !isWholeEuros(amountMax, 0, MAX_FUNDING_AMOUNT)) {
    return failure('funding_details_required', 'amountMax must be whole euros');
  }
  if (amountMin !== null && amountMax !== null && amountMax < amountMin) {
    return failure(
      'funding_details_required',
      'amountMax must be at least amountMin',
    );
  }
  const eligibility: FundingEligibility[] = [];
  for (const value of input.eligibility ?? []) {
    if (!includesValue(FUNDING_ELIGIBILITIES, value)) {
      return failure(
        'funding_details_required',
        `eligibility value ${value} is not recognised`,
      );
    }
    if (!eligibility.includes(value)) eligibility.push(value);
  }
  const deadline = parseFutureInstant(
    input.deadline,
    'deadline',
    context.previousDeadline,
    context.now,
    MAX_CALL_DEADLINE_AHEAD_MS,
  );
  if (!deadline.ok) return deadline;
  return {
    ok: true,
    value: {
      kind: 'call',
      ...link,
      funderName,
      amountMin,
      amountMax,
      deadline: deadline.value,
      eligibility,
      scope,
      goalAmount: null,
      askPurpose: null,
      beneficiary: null,
      endsAt: null,
    },
  };
}

function validateAskFields(
  link: NormalizedFundingLink,
  input: FundingInput,
  context: FundingValidationContext,
): FundingValidationResult {
  const goalAmount = input.goalAmount ?? null;
  if (
    goalAmount === null ||
    !isWholeEuros(goalAmount, 1, MAX_ASK_GOAL_AMOUNT)
  ) {
    return failure(
      'funding_details_required',
      'goalAmount is required for a fundraiser, in whole euros above zero',
    );
  }
  const askPurpose = input.askPurpose;
  if (!includesValue(ASK_PURPOSES, askPurpose)) {
    return failure(
      'funding_details_required',
      'askPurpose is required for a fundraiser',
    );
  }
  const beneficiary = input.beneficiary;
  if (!includesValue(ASK_BENEFICIARIES, beneficiary)) {
    return failure(
      'funding_details_required',
      'beneficiary is required for a fundraiser',
    );
  }
  const endsAt = parseFutureInstant(
    input.endsAt,
    'endsAt',
    context.previousEndsAt,
    context.now,
    MAX_ASK_RUN_MS,
  );
  if (!endsAt.ok) return endsAt;
  return {
    ok: true,
    value: {
      kind: 'ask',
      ...link,
      funderName: null,
      amountMin: null,
      amountMax: null,
      deadline: null,
      eligibility: [],
      scope: null,
      goalAmount,
      askPurpose,
      beneficiary,
      endsAt: endsAt.value,
    },
  };
}

/**
 * Validates one `funding` object for its kind. Fields that belong to the other
 * kind are dropped (the composer may send them as nulls). The ask-only rules
 * that need the thread's text or the author (anonymity, payment details,
 * verification, the one-active limit) live in `ForumFundingService`.
 */
export function validateFundingInput(
  kind: FundingKind,
  input: FundingInput,
  context: FundingValidationContext,
): FundingValidationResult {
  const link = normalizeFundingLink(input.linkUrl ?? '');
  if (!link) {
    return failure(
      'funding_link_invalid',
      'linkUrl must be a full https address',
    );
  }
  if (kind === 'ask') {
    if (new URL(link.linkUrl).port !== '') {
      return failure(
        'funding_link_host_not_allowed',
        'Fundraiser links cannot name a port',
      );
    }
    if (!isAllowListedFundingHost(link.linkHost)) {
      return failure(
        'funding_link_host_not_allowed',
        `Fundraisers link to one of: ${FUNDING_LINK_HOST_ALLOW_LIST.join(', ')}`,
      );
    }
    return validateAskFields(link, input, context);
  }
  return validateCallFields(link, input, context);
}

/**
 * The stored tag set with the server-owned `open-call` tag applied: first on a
 * call (so the cap never squeezes it out), absent everywhere else.
 * `normalizedTags` is `normalizeTags` output from the threads service.
 */
export function withServerOwnedFundingTag(
  kind: string | null,
  normalizedTags: readonly string[],
  maxTags: number,
): string[] {
  const memberTags = normalizedTags.filter((tag) => tag !== OPEN_CALL_TAG);
  if (kind !== 'call') return memberTags.slice(0, maxTags);
  return [OPEN_CALL_TAG, ...memberTags].slice(0, maxTags);
}

export function hasDeadlineChanged(
  previous: Date | null,
  next: Date | null,
): boolean {
  if (previous === null || next === null) return previous !== next;
  return previous.getTime() !== next.getTime();
}
