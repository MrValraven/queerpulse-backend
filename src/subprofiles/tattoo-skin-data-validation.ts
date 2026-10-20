import { isEmail } from 'class-validator';
import { isSafeUrlValue } from '../common/validators/is-safe-url.decorator';
import { tattooSkinInvalid } from './tattoo-artist-errors';
import {
  isCalendarDate,
  TATTOO_BOOKING_ROUTES,
  TATTOO_BOOKS_STATUSES,
  TATTOO_COLOURS,
  TATTOO_COMFORT_OPTIONS,
  TATTOO_CONSULTATIONS,
  TATTOO_HYGIENE_PRACTICES,
  TATTOO_LIMITS,
  TATTOO_PRICE_PATTERN,
  TATTOO_STYLES,
  TATTOO_WHAT_TO_SEND,
} from './tattoo-artist-vocab';

/**
 * A rule checks one value and returns the dot path of the first violation, or
 * null when the value is valid. `path` is the dot path of the value itself.
 */
type SkinRule = (value: unknown, path: string, now: Date) => string | null;

const WHOLE_MONTHS_PATTERN = /^[1-9]\d?$/;
const FOUR_DIGIT_YEAR_PATTERN = /^\d{4}$/;
const HTTPS_PREFIX = 'https://';

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An object whose keys are exactly the schema keys, each optional. */
function objectRule(schema: Record<string, SkinRule>): SkinRule {
  return (value, path, now) => {
    if (!isPlainObject(value)) {
      return path;
    }
    for (const key of Object.keys(value)) {
      if (!Object.hasOwn(schema, key)) {
        return `${path}.${key}`;
      }
    }
    for (const [key, rule] of Object.entries(schema)) {
      const fieldValue = value[key];
      if (fieldValue === undefined) {
        continue;
      }
      const violation = rule(fieldValue, `${path}.${key}`, now);
      if (violation !== null) {
        return violation;
      }
    }
    return null;
  };
}

const booleanRule: SkinRule = (value, path) =>
  typeof value === 'boolean' ? null : path;

/** Trimmed text up to `maxLength`; "" means not set. */
function textRule(maxLength: number): SkinRule {
  return (value, path) =>
    typeof value === 'string' && value.trim().length <= maxLength ? null : path;
}

/** "" (not set) or one of the listed values. */
function enumRule(allowedValues: readonly string[]): SkinRule {
  return (value, path) =>
    typeof value === 'string' && (value === '' || allowedValues.includes(value))
      ? null
      : path;
}

/** A list of listed values without duplicates. The index of the bad entry is the path. */
function enumListRule(allowedValues: readonly string[]): SkinRule {
  return (value, path) => {
    if (!Array.isArray(value)) {
      return path;
    }
    const seenValues = new Set<string>();
    for (let entryIndex = 0; entryIndex < value.length; entryIndex += 1) {
      const entry: unknown = value[entryIndex];
      if (
        typeof entry !== 'string' ||
        !allowedValues.includes(entry) ||
        seenValues.has(entry)
      ) {
        return `${path}.${entryIndex}`;
      }
      seenValues.add(entry);
    }
    return null;
  };
}

/** A list of free lines: at most `maxCount` entries, each up to `maxLineLength`, no duplicates. */
function textListRule(maxCount: number, maxLineLength: number): SkinRule {
  return (value, path) => {
    if (!Array.isArray(value) || value.length > maxCount) {
      return path;
    }
    const seenLines = new Set<string>();
    for (let lineIndex = 0; lineIndex < value.length; lineIndex += 1) {
      const line: unknown = value[lineIndex];
      if (typeof line !== 'string') {
        return `${path}.${lineIndex}`;
      }
      const trimmedLine = line.trim();
      if (trimmedLine.length > maxLineLength || seenLines.has(trimmedLine)) {
        return `${path}.${lineIndex}`;
      }
      seenLines.add(trimmedLine);
    }
    return null;
  };
}

const stylesRule: SkinRule = (value, path) => {
  if (!Array.isArray(value) || value.length > TATTOO_LIMITS.stylesMax) {
    return path;
  }
  const seenStyles = new Set<string>();
  for (let styleIndex = 0; styleIndex < value.length; styleIndex += 1) {
    const style: unknown = value[styleIndex];
    if (typeof style !== 'string') {
      return `${path}.${styleIndex}`;
    }
    const trimmedStyle = style.trim();
    const isKnownStyleId = (TATTOO_STYLES as readonly string[]).includes(
      trimmedStyle,
    );
    const isValidCustomStyle =
      trimmedStyle.length >= 1 &&
      trimmedStyle.length <= TATTOO_LIMITS.styleCustomMax;
    const duplicateKey = trimmedStyle.toLowerCase();
    if (
      !(isKnownStyleId || isValidCustomStyle) ||
      seenStyles.has(duplicateKey)
    ) {
      return `${path}.${styleIndex}`;
    }
    seenStyles.add(duplicateKey);
  }
  return null;
};

const nextOpeningRule: SkinRule = (value, path) =>
  typeof value === 'string' && (value === '' || isCalendarDate(value))
    ? null
    : path;

const emailRule: SkinRule = (value, path) => {
  if (typeof value !== 'string') {
    return path;
  }
  const trimmedEmail = value.trim();
  if (trimmedEmail === '') {
    return null;
  }
  return trimmedEmail.length <= TATTOO_LIMITS.emailMax && isEmail(trimmedEmail)
    ? null
    : path;
};

const formUrlRule: SkinRule = (value, path) => {
  if (typeof value !== 'string') {
    return path;
  }
  const trimmedUrl = value.trim();
  if (trimmedUrl === '') {
    return null;
  }
  return trimmedUrl.length <= TATTOO_LIMITS.formUrlMax &&
    isSafeUrlValue(trimmedUrl) &&
    trimmedUrl.toLowerCase().startsWith(HTTPS_PREFIX)
    ? null
    : path;
};

const priceRule: SkinRule = (value, path) =>
  typeof value === 'string' &&
  (value === '' || TATTOO_PRICE_PATTERN.test(value))
    ? null
    : path;

const touchUpMonthsRule: SkinRule = (value, path) =>
  typeof value === 'string' &&
  (value === '' ||
    (WHOLE_MONTHS_PATTERN.test(value) &&
      Number(value) <= TATTOO_LIMITS.touchUpMonthsMax))
    ? null
    : path;

const tattooingSinceRule: SkinRule = (value, path, now) =>
  typeof value === 'string' &&
  (value === '' ||
    (FOUR_DIGIT_YEAR_PATTERN.test(value) &&
      Number(value) >= TATTOO_LIMITS.tattooingSinceMin &&
      Number(value) <= now.getUTCFullYear()))
    ? null
    : path;

const TATTOO_BLOCK_RULES: Record<string, SkinRule> = {
  tattoo: objectRule({
    status: enumRule(TATTOO_BOOKS_STATUSES),
    nextOpening: nextOpeningRule,
    waitNote: textRule(TATTOO_LIMITS.waitNoteMax),
  }),
  tattooBooking: objectRule({
    route: enumRule(TATTOO_BOOKING_ROUTES),
    email: emailRule,
    formUrl: formUrlRule,
    whatToSend: enumListRule(TATTOO_WHAT_TO_SEND),
    consultation: enumRule(TATTOO_CONSULTATIONS),
    replyTime: textRule(TATTOO_LIMITS.replyTimeMax),
  }),
  tattooStyles: objectRule({
    styles: stylesRule,
    colour: enumRule(TATTOO_COLOURS),
    minSize: textRule(TATTOO_LIMITS.minSizeMax),
    doesNotDo: textListRule(
      TATTOO_LIMITS.doesNotDoMax,
      TATTOO_LIMITS.doesNotDoLineMax,
    ),
  }),
  tattooPrices: objectRule({
    minimum: priceRule,
    hourly: priceRule,
    dayRate: priceRule,
    deposit: objectRule({
      amount: priceRule,
      isRefundable: booleanRule,
      note: textRule(TATTOO_LIMITS.depositNoteMax),
    }),
    cancellation: textRule(TATTOO_LIMITS.cancellationMax),
    touchUps: objectRule({
      isFree: booleanRule,
      months: touchUpMonthsRule,
    }),
  }),
  tattooComfort: objectRule({
    options: enumListRule(TATTOO_COMFORT_OPTIONS),
    note: textRule(TATTOO_LIMITS.comfortNoteMax),
  }),
  tattooHygiene: objectRule({
    practices: enumListRule(TATTOO_HYGIENE_PRACTICES),
  }),
  tattooScarWork: objectRule({
    intro: textRule(TATTOO_LIMITS.scarIntroMax),
    hasFreeConsult: booleanRule,
    hasReducedPrice: booleanRule,
    reducedPriceNote: textRule(TATTOO_LIMITS.reducedPriceNoteMax),
  }),
  tattooStudio: objectRule({
    city: textRule(TATTOO_LIMITS.cityMax),
    isPrivateStudio: booleanRule,
    isByAppointmentOnly: booleanRule,
  }),
  tattooLineage: objectRule({
    trainedWith: textRule(TATTOO_LIMITS.trainedWithMax),
    tattooingSince: tattooingSinceRule,
    isTakingApprentices: booleanRule,
    apprenticeNote: textRule(TATTOO_LIMITS.apprenticeNoteMax),
    teaches: textListRule(
      TATTOO_LIMITS.teachesMax,
      TATTOO_LIMITS.teachesLineMax,
    ),
  }),
};

/**
 * Validates the nine `tattoo*` blocks of a persona's skinData whenever they are
 * present and non-null, for any kind. Returns the dot path of the first
 * violation (e.g. `tattooPrices.deposit.amount`), or null. Every other key
 * (`venue`, `faq`, the therapist blocks) stays unvalidated.
 */
export function findTattooSkinDataViolation(
  skinData: unknown,
  now: Date,
): string | null {
  if (!isPlainObject(skinData)) {
    return null;
  }
  for (const [blockKey, blockRule] of Object.entries(TATTOO_BLOCK_RULES)) {
    const blockValue = skinData[blockKey];
    if (blockValue === undefined || blockValue === null) {
      continue;
    }
    const violation = blockRule(blockValue, blockKey, now);
    if (violation !== null) {
      return violation;
    }
  }
  return null;
}

/** Throws 400 TATTOO_SKIN_INVALID carrying the path of the first violation. */
export function assertValidTattooSkinData(
  skinData: unknown,
  now: Date = new Date(),
): void {
  const violationPath = findTattooSkinDataViolation(skinData, now);
  if (violationPath !== null) {
    throw tattooSkinInvalid(violationPath);
  }
}
