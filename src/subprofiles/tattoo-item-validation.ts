import { isImageReferenceValue } from '../common/validators/is-image-reference.decorator';
import { isSafeUrlValue } from '../common/validators/is-safe-url.decorator';
import type { SubprofileItemInputDTO } from './dto/replace-items.dto';
import type { SubprofileSection } from './entities/subprofile-item.entity';
import { tattooItemInvalid } from './tattoo-artist-errors';
import {
  isCalendarDate,
  isTattooBodyPhotoSection,
  isTattooItemSection,
  TATTOO_COVER_UP_TYPES,
  TATTOO_FLASH_AVAILABILITIES,
  TATTOO_GUEST_SPOT_TYPES,
  TATTOO_LIMITS,
  TATTOO_PRICE_PATTERN,
  TATTOO_SCAR_WORK_TYPES,
  TATTOO_SHOP_PRODUCT_TYPES,
  TATTOO_SKIN_TONES,
} from './tattoo-artist-vocab';
import type { TATTOO_ITEM_SECTIONS } from './tattoo-artist-vocab';

/** The first item a save refuses, with the dot path of the failing field. */
export interface TattooItemViolation {
  itemIndex: number;
  field: string;
}

/** The parts of an item the tattoo whitelist reads. */
export type TattooValidatedItem = Pick<
  SubprofileItemInputDTO,
  'imageUrl' | 'date' | 'url' | 'collaborators' | 'structured'
>;

type TattooItemSection = (typeof TATTOO_ITEM_SECTIONS)[number];

/** The nine `structured` keys the tattoo artist page adds. */
const TATTOO_STRUCTURED_KEYS = [
  'flash',
  'healed',
  'photo',
  'coverUp',
  'scarWork',
  'sessions',
  'spot',
  'flashDay',
  'shop',
] as const;

type TattooStructuredKey = (typeof TATTOO_STRUCTURED_KEYS)[number];

interface SectionRule {
  allowedKeys: readonly TattooStructuredKey[];
  requiredKeys: readonly TattooStructuredKey[];
}

// The contract's "Per-section rules" table: the only `structured` keys each
// tattoo section may carry, and the ones it must carry.
const SECTION_RULES: Readonly<Record<TattooItemSection, SectionRule>> = {
  flash: { allowedKeys: ['flash'], requiredKeys: [] },
  wanna_dos: { allowedKeys: ['flash'], requiredKeys: [] },
  healed: { allowedKeys: ['healed', 'photo'], requiredKeys: [] },
  in_progress: { allowedKeys: ['sessions', 'photo'], requiredKeys: [] },
  cover_ups: { allowedKeys: ['coverUp', 'photo'], requiredKeys: ['coverUp'] },
  scar_work: {
    allowedKeys: ['scarWork', 'photo'],
    requiredKeys: ['scarWork'],
  },
  guest_spots: { allowedKeys: ['spot'], requiredKeys: ['spot'] },
  flash_days: { allowedKeys: ['flashDay'], requiredKeys: [] },
  shop: { allowedKeys: ['shop'], requiredKeys: ['shop'] },
};

/**
 * A check returns `null` when the value passes, or the failing path relative
 * to the value: `''` for the value itself, `'3.imageUrl'` for a nested field.
 */
type FieldCheck = (value: unknown) => string | null;

const FAILS_HERE = '';

function joinPath(head: string, tail: string): string {
  return tail === FAILS_HERE ? head : `${head}.${tail}`;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

function textUpTo(maxLength: number): FieldCheck {
  return (value) =>
    typeof value === 'string' && value.trim().length <= maxLength
      ? null
      : FAILS_HERE;
}

function oneOf(allowedValues: readonly string[]): FieldCheck {
  return (value) =>
    typeof value === 'string' && allowedValues.includes(value)
      ? null
      : FAILS_HERE;
}

// An optional enum reads `""` as not set, like the optional skinData enums.
function oneOfOrEmpty(allowedValues: readonly string[]): FieldCheck {
  const checkListed = oneOf(allowedValues);
  return (value) => (value === '' ? null : checkListed(value));
}

const checkBoolean: FieldCheck = (value) =>
  typeof value === 'boolean' ? null : FAILS_HERE;

const checkAnyString: FieldCheck = (value) =>
  typeof value === 'string' ? null : FAILS_HERE;

// `""` means the price is not set.
const checkPrice: FieldCheck = (value) =>
  typeof value === 'string' &&
  (value === '' || TATTOO_PRICE_PATTERN.test(value))
    ? null
    : FAILS_HERE;

const checkCalendarDateOrEmpty: FieldCheck = (value) =>
  typeof value === 'string' && (value === '' || isCalendarDate(value))
    ? null
    : FAILS_HERE;

const checkRequiredImage: FieldCheck = (value) =>
  typeof value === 'string' &&
  value.trim() !== '' &&
  isImageReferenceValue(value)
    ? null
    : FAILS_HERE;

// `""` is a before photo a rehome dropped: the row then shows its after photo
// alone and the editor asks the owner for a new one.
const checkBeforeImage: FieldCheck = (value) =>
  typeof value === 'string' && (value === '' || isImageReferenceValue(value))
    ? null
    : FAILS_HERE;

const checkPlacements: FieldCheck = (value) => {
  if (!Array.isArray(value) || value.length > TATTOO_LIMITS.placementsMax) {
    return FAILS_HERE;
  }
  const seenPlacements = new Set<string>();
  for (const [placementIndex, placement] of (value as unknown[]).entries()) {
    if (typeof placement !== 'string') {
      return String(placementIndex);
    }
    const trimmedPlacement = placement.trim();
    const comparablePlacement = trimmedPlacement.toLowerCase();
    if (
      trimmedPlacement === '' ||
      trimmedPlacement.length > TATTOO_LIMITS.placementMax ||
      seenPlacements.has(comparablePlacement)
    ) {
      return String(placementIndex);
    }
    seenPlacements.add(comparablePlacement);
  }
  return null;
};

/**
 * Checks an object field by field: refuses a sub-key outside `fieldChecks`,
 * then a missing required sub-key, then the first sub-key whose check fails.
 */
function checkFields(
  value: unknown,
  fieldChecks: Readonly<Record<string, FieldCheck>>,
  requiredFields: readonly string[] = [],
): string | null {
  if (!isPlainRecord(value)) {
    return FAILS_HERE;
  }
  const knownFields = Object.keys(fieldChecks);
  const unknownField = Object.keys(value).find(
    (fieldName) => !knownFields.includes(fieldName),
  );
  if (unknownField !== undefined) {
    return unknownField;
  }
  const missingField = requiredFields.find(
    (fieldName) => value[fieldName] === undefined,
  );
  if (missingField !== undefined) {
    return missingField;
  }
  for (const [fieldName, fieldCheck] of Object.entries(fieldChecks)) {
    const fieldValue = value[fieldName];
    if (fieldValue === undefined) {
      continue;
    }
    const failure = fieldCheck(fieldValue);
    if (failure !== null) {
      return joinPath(fieldName, failure);
    }
  }
  return null;
}

const checkFlashSize: FieldCheck = textUpTo(TATTOO_LIMITS.sizeMax);

const FLASH_FIELD_CHECKS: Readonly<Record<string, FieldCheck>> = {
  availability: oneOfOrEmpty(TATTOO_FLASH_AVAILABILITIES),
  size: checkFlashSize,
  price: checkPrice,
  placements: checkPlacements,
};

// A wanna do is a design the artist would love to tattoo: it has a size and
// placements, and no price or availability yet.
const WANNA_DO_FIELD_CHECKS: Readonly<Record<string, FieldCheck>> = {
  size: checkFlashSize,
  placements: checkPlacements,
};

const SESSION_FIELD_CHECKS: Readonly<Record<string, FieldCheck>> = {
  imageUrl: checkRequiredImage,
  date: checkCalendarDateOrEmpty,
  note: textUpTo(TATTOO_LIMITS.sessionNoteMax),
};

const checkSessions: FieldCheck = (value) => {
  if (
    !Array.isArray(value) ||
    value.length < 1 ||
    value.length > TATTOO_LIMITS.sessionsMax
  ) {
    return FAILS_HERE;
  }
  for (const [sessionIndex, session] of (value as unknown[]).entries()) {
    const failure = checkFields(session, SESSION_FIELD_CHECKS, ['imageUrl']);
    if (failure !== null) {
      return joinPath(String(sessionIndex), failure);
    }
  }
  return null;
};

type StructuredKeyCheck = (
  value: unknown,
  section: TattooItemSection,
  item: TattooValidatedItem,
) => string | null;

// One checker per tattoo key, each returning the failing path below the key.
const STRUCTURED_KEY_CHECKS: Readonly<
  Record<TattooStructuredKey, StructuredKeyCheck>
> = {
  flash: (value, section) =>
    checkFields(
      value,
      section === 'wanna_dos' ? WANNA_DO_FIELD_CHECKS : FLASH_FIELD_CHECKS,
    ),
  healed: (value) =>
    checkFields(value, {
      healedFor: textUpTo(TATTOO_LIMITS.healedForMax),
      placement: textUpTo(TATTOO_LIMITS.healedPlacementMax),
      skinTone: oneOfOrEmpty(TATTOO_SKIN_TONES),
    }),
  photo: (value) =>
    checkFields(value, {
      hasClientConsent: checkBoolean,
      isBlurred: checkBoolean,
    }),
  coverUp: (value) =>
    checkFields(
      value,
      { type: oneOf(TATTOO_COVER_UP_TYPES), beforeImageUrl: checkBeforeImage },
      ['type', 'beforeImageUrl'],
    ),
  scarWork: (value) =>
    checkFields(value, { type: oneOf(TATTOO_SCAR_WORK_TYPES) }, ['type']),
  sessions: (value) => checkSessions(value),
  spot: (value, _section, item) => {
    const failure = checkFields(
      value,
      {
        type: oneOf(TATTOO_GUEST_SPOT_TYPES),
        endDate: checkCalendarDateOrEmpty,
      },
      ['type'],
    );
    if (failure !== null) {
      return failure;
    }
    // ISO calendar dates compare correctly as strings. A missing or broken
    // start date is reported on `date` by the section rules.
    const endDate = (value as Record<string, unknown>).endDate;
    const startDate = item.date;
    const isEndBeforeStart =
      typeof endDate === 'string' &&
      endDate !== '' &&
      typeof startDate === 'string' &&
      isCalendarDate(startDate) &&
      endDate < startDate;
    return isEndBeforeStart ? 'endDate' : null;
  },
  flashDay: (value) =>
    checkFields(value, {
      eventSlug: checkAnyString,
      cause: textUpTo(TATTOO_LIMITS.causeMax),
    }),
  shop: (value) =>
    checkFields(
      value,
      { type: oneOf(TATTOO_SHOP_PRODUCT_TYPES), price: checkPrice },
      ['type'],
    ),
};

function isTattooStructuredKey(key: string): key is TattooStructuredKey {
  return (TATTOO_STRUCTURED_KEYS as readonly string[]).includes(key);
}

function structuredPath(key: string, failure: string): string {
  return joinPath(`structured.${key}`, failure);
}

/** The item fields each tattoo section requires outside `structured`. */
function findItemFieldViolation(
  section: TattooItemSection,
  item: TattooValidatedItem,
): string | null {
  if (
    section === 'cover_ups' &&
    (typeof item.imageUrl !== 'string' || item.imageUrl.trim() === '')
  ) {
    return 'imageUrl';
  }
  if (
    (section === 'guest_spots' || section === 'flash_days') &&
    (typeof item.date !== 'string' || !isCalendarDate(item.date))
  ) {
    return 'date';
  }
  // The DTO's `@IsSafeUrl` already ran; a shop link must also be https.
  if (
    section === 'shop' &&
    (typeof item.url !== 'string' ||
      !item.url.startsWith('https://') ||
      !isSafeUrlValue(item.url))
  ) {
    return 'url';
  }
  if (
    isTattooBodyPhotoSection(section) &&
    Array.isArray(item.collaborators) &&
    item.collaborators.length > 0
  ) {
    return 'collaborators';
  }
  return null;
}

function findTattooSectionItemViolation(
  section: TattooItemSection,
  item: TattooValidatedItem,
): string | null {
  const structured: unknown = item.structured ?? {};
  if (!isPlainRecord(structured)) {
    return 'structured';
  }
  const rule = SECTION_RULES[section];
  for (const [key, value] of Object.entries(structured)) {
    if (isAbsent(value)) {
      continue;
    }
    if (!isTattooStructuredKey(key) || !rule.allowedKeys.includes(key)) {
      return `structured.${key}`;
    }
  }
  const missingKey = rule.requiredKeys.find((key) => isAbsent(structured[key]));
  if (missingKey !== undefined) {
    return `structured.${missingKey}`;
  }
  for (const key of rule.allowedKeys) {
    const value = structured[key];
    if (isAbsent(value)) {
      continue;
    }
    const failure = STRUCTURED_KEY_CHECKS[key](value, section, item);
    if (failure !== null) {
      return structuredPath(key, failure);
    }
  }
  return findItemFieldViolation(section, item);
}

// Outside the tattoo sections the nine tattoo keys are refused; every other
// key keeps the checks it has today.
function findOtherSectionItemViolation(
  item: TattooValidatedItem,
): string | null {
  const structured: unknown = item.structured;
  if (!isPlainRecord(structured)) {
    return null;
  }
  const presentTattooKey = TATTOO_STRUCTURED_KEYS.find(
    (key) => !isAbsent(structured[key]),
  );
  return presentTattooKey === undefined
    ? null
    : `structured.${presentTattooKey}`;
}

/**
 * The first item of a section save that breaks the tattoo `structured`
 * whitelist (contract "Per-section rules"), or null when every item passes.
 * A key whose value is `null` counts as absent.
 */
export function findTattooItemViolation(
  section: SubprofileSection,
  items: readonly TattooValidatedItem[],
): TattooItemViolation | null {
  const sectionName: string = section;
  const isTattooSection = isTattooItemSection(sectionName);
  for (const [itemIndex, item] of items.entries()) {
    const field = isTattooSection
      ? findTattooSectionItemViolation(sectionName as TattooItemSection, item)
      : findOtherSectionItemViolation(item);
    if (field !== null) {
      return { itemIndex, field };
    }
  }
  return null;
}

/** Throws 400 `TATTOO_ITEM_INVALID` with `{ itemIndex, field }` on the first bad item. */
export function assertValidTattooItems(
  section: SubprofileSection,
  items: readonly TattooValidatedItem[],
): void {
  const violation = findTattooItemViolation(section, items);
  if (violation !== null) {
    throw tattooItemInvalid(violation.itemIndex, violation.field);
  }
}
