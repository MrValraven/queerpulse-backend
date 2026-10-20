import { BadRequestException } from '@nestjs/common';
import {
  IBAN_LENGTH_BY_COUNTRY,
  PT_MOBILE_PATTERN,
  hasValidIbanChecksum,
} from '../forum/forum-funding';
import { toStoredPlainTextOrNull } from './community-plain-text';
import { CommunityGivingKind } from './entities/community-giving-method.entity';
import { isHttpUrl } from './is-http-url.validator';

/**
 * Value rules for a community's giving section (code id `giving`): the
 * limits, the per-kind normalisers, the coded 400s, and the governance log
 * summary and diff.
 *
 * Every function here is pure. The frontend mirrors these rules so the editor
 * can warn before Save, but this file is authoritative: whatever reaches the
 * database passed through `normalizeGivingInput`.
 *
 * Error messages are fixed strings and must never interpolate a submitted
 * value. A 400 message lands in the pino request line through
 * `request-failure-log.ts`, so an echoed IBAN or phone number would be
 * written to the logs.
 */

export const MAX_GIVING_METHODS = 8;
export const MAX_GIVING_INTRO_LENGTH = 400;
export const MAX_GIVING_LABEL_LENGTH = 60;
export const MAX_GIVING_NOTE_LENGTH = 160;
export const MAX_GIVING_VALUE_LENGTH = 500;

export type GivingErrorCode =
  | 'GIVING_TOO_MANY_METHODS'
  | 'GIVING_LINK_INVALID'
  | 'GIVING_MBWAY_INVALID'
  | 'GIVING_IBAN_INVALID';

export interface GivingMethodShape {
  kind: CommunityGivingKind;
  label: string | null;
  value: string;
  note: string | null;
}

export interface GivingInput {
  intro: string | null;
  methods: {
    kind: CommunityGivingKind;
    value: string;
    label?: string | null;
    note?: string | null;
  }[];
}

export interface NormalizedGiving {
  intro: string | null;
  methods: GivingMethodShape[];
}

// The forum's PT mobile pattern finds a number inside prose. Anchored here so
// the whole field has to be one number, with the same accepted groupings.
const PT_MOBILE_WHOLE_VALUE_PATTERN = new RegExp(
  `^(?:${PT_MOBILE_PATTERN.source})$`,
);
const IBAN_LABEL_PREFIX_PATTERN = /^IBAN[\s:]*/i;
const IBAN_SEPARATOR_PATTERN = /[\s.-]/g;
const IBAN_SHAPE_PATTERN = /^[A-Z]{2}\d{2}[A-Z0-9]+$/;
const MBWAY_NATIONAL_DIGITS = 9;

const GIVING_ERROR_MESSAGES: Record<GivingErrorCode, string> = {
  GIVING_TOO_MANY_METHODS: `A community can list at most ${MAX_GIVING_METHODS} ways to support it`,
  GIVING_LINK_INVALID: 'A link must be a full https:// address',
  GIVING_MBWAY_INVALID: 'MB WAY needs a Portuguese mobile number',
  GIVING_IBAN_INVALID:
    'Check the IBAN: the country code, length or check digits do not match',
};

const GIVING_KIND_NAMES: Record<CommunityGivingKind, string> = {
  [CommunityGivingKind.Link]: 'Link',
  [CommunityGivingKind.Mbway]: 'MB WAY',
  [CommunityGivingKind.Iban]: 'IBAN',
};

/**
 * The coded 400 for a giving write. `index` is the zero-based row in
 * `methods` that failed; it is left out for a whole-request refusal.
 */
export function givingException(
  code: GivingErrorCode,
  index?: number,
): BadRequestException {
  return new BadRequestException({
    statusCode: 400,
    message: GIVING_ERROR_MESSAGES[code],
    code,
    ...(index === undefined ? {} : { index }),
  });
}

const HTTPS_SCHEME_PREFIX_PATTERN = /^https:\/\//i;
const ASCII_SPACE_CODE = 0x20;
const ASCII_DELETE_CODE = 0x7f;

/**
 * Whether the value holds an ASCII space, tab, line break or other control
 * character (U+0000 to U+0020, U+007F) anywhere. The URL parser silently
 * strips or percent-encodes these, so the stored value would differ from
 * the address the parser checked.
 */
function hasWhitespaceOrControlCharacter(value: string): boolean {
  for (let position = 0; position < value.length; position += 1) {
    const characterCode = value.charCodeAt(position);
    if (
      characterCode <= ASCII_SPACE_CODE ||
      characterCode === ASCII_DELETE_CODE
    ) {
      return true;
    }
  }
  return false;
}

/**
 * An absolute https URL with a host and no `user:password@` part, returned
 * trimmed and otherwise exactly as entered. No scheme is ever added.
 *
 * The literal `https://` prefix (any case) is required on the raw value
 * because the URL parser repairs `https:ko-fi.com` and `https:\\ko-fi.com`
 * into a valid address, while the value stored and rendered is the raw one.
 */
export function normalizeGivingLink(value: string): string | null {
  const trimmed = value.trim();
  if (!HTTPS_SCHEME_PREFIX_PATTERN.test(trimmed)) return null;
  if (hasWhitespaceOrControlCharacter(trimmed)) return null;
  if (!isHttpUrl(trimmed)) return null;
  const parsed = new URL(trimmed);
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  return trimmed;
}

/**
 * A Portuguese mobile written any way the forum pattern accepts, returned as
 * its 9 national digits (the `+351` / `00351` prefix and separators dropped).
 */
export function normalizeMbwayNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!PT_MOBILE_WHOLE_VALUE_PATTERN.test(trimmed)) return null;
  return trimmed.replace(/\D/g, '').slice(-MBWAY_NATIONAL_DIGITS);
}

/**
 * An IBAN with an optional leading `IBAN` / `IBAN:` label, any spaces (NBSP
 * included), dots or dashes, in any case. Returned uppercase with no
 * separators when the country is known, the length matches that country and
 * the mod-97 checksum passes.
 */
export function normalizeIban(value: string): string | null {
  const compact = value
    .trim()
    .replace(IBAN_LABEL_PREFIX_PATTERN, '')
    .replace(IBAN_SEPARATOR_PATTERN, '')
    .toUpperCase();
  if (!IBAN_SHAPE_PATTERN.test(compact)) return null;
  const expectedLength = IBAN_LENGTH_BY_COUNTRY[compact.slice(0, 2)];
  if (expectedLength === undefined || compact.length !== expectedLength) {
    return null;
  }
  return hasValidIbanChecksum(compact) ? compact : null;
}

const NORMALIZER_BY_KIND: Record<
  CommunityGivingKind,
  {
    normalize: (value: string) => string | null;
    errorCode: GivingErrorCode;
  }
> = {
  [CommunityGivingKind.Link]: {
    normalize: normalizeGivingLink,
    errorCode: 'GIVING_LINK_INVALID',
  },
  [CommunityGivingKind.Mbway]: {
    normalize: normalizeMbwayNumber,
    errorCode: 'GIVING_MBWAY_INVALID',
  },
  [CommunityGivingKind.Iban]: {
    normalize: normalizeIban,
    errorCode: 'GIVING_IBAN_INVALID',
  },
};

/**
 * Validates and canonicalises a whole PUT body. The method count is checked
 * before any value is read. Array order is kept (it becomes `position`).
 * Intro, label and note are stripped of markup; empty results become null.
 *
 * @throws BadRequestException from `givingException` on the first failure.
 */
export function normalizeGivingInput(input: GivingInput): NormalizedGiving {
  if (input.methods.length > MAX_GIVING_METHODS) {
    throw givingException('GIVING_TOO_MANY_METHODS');
  }
  const methods = input.methods.map((method, index): GivingMethodShape => {
    const { normalize, errorCode } = NORMALIZER_BY_KIND[method.kind];
    const value = normalize(method.value);
    if (value === null) throw givingException(errorCode, index);
    return {
      kind: method.kind,
      value,
      label: toStoredPlainTextOrNull(method.label),
      note: toStoredPlainTextOrNull(method.note),
    };
  });
  return { intro: toStoredPlainTextOrNull(input.intro), methods };
}

/**
 * One governance log line for a method:
 * `<kind name>[ "<label>"]: <value>[ (<note>)]`.
 */
export function summarizeGivingMethod(method: GivingMethodShape): string {
  const kindName = GIVING_KIND_NAMES[method.kind];
  const labelPart = method.label === null ? '' : ` "${method.label}"`;
  const notePart = method.note === null ? '' : ` (${method.note})`;
  return `${kindName}${labelPart}: ${method.value}${notePart}`;
}

/**
 * Field-by-field comparison of two method lists in order. The summary strings
 * cannot answer this: a label or note holding `": "` or `(` can make two
 * different methods summarise to the same line.
 */
function hasSameMethods(
  beforeMethods: GivingMethodShape[],
  afterMethods: GivingMethodShape[],
): boolean {
  return (
    beforeMethods.length === afterMethods.length &&
    beforeMethods.every((beforeMethod, position) => {
      const afterMethod = afterMethods[position];
      return (
        afterMethod !== undefined &&
        beforeMethod.kind === afterMethod.kind &&
        beforeMethod.label === afterMethod.label &&
        beforeMethod.value === afterMethod.value &&
        beforeMethod.note === afterMethod.note
      );
    })
  );
}

/**
 * The `metadata.changes` payload for a `settings_changed` governance entry.
 * Only keys that changed are present; an empty object means the PUT changes
 * nothing. "Changed" compares the intro by value and the methods as
 * `{ kind, label, value, note }` tuples in order, so a reorder counts as a
 * `givingMethods` change. The summary strings are only the log payload.
 */
export function diffGiving(
  before: NormalizedGiving,
  after: NormalizedGiving,
): Record<string, { from: unknown; to: unknown }> {
  const changes: Record<string, { from: unknown; to: unknown }> = {};
  if (before.intro !== after.intro) {
    changes.givingIntro = { from: before.intro, to: after.intro };
  }
  if (!hasSameMethods(before.methods, after.methods)) {
    changes.givingMethods = {
      from: before.methods.map(summarizeGivingMethod),
      to: after.methods.map(summarizeGivingMethod),
    };
  }
  return changes;
}
