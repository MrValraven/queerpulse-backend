import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { DraftMeta, DraftMetaValue } from '../entities/draft.entity';

/**
 * The whole bag, serialized, in bytes.
 *
 * A draft autosaves on a debounce while the member types, so this column is
 * written far more often than most. 8 KB is roomy for what a composer actually
 * remembers about itself (a handful of ids, up to a few dozen tags, one image
 * reference) and small enough that an abusive client cannot use `/me/drafts` as
 * free object storage: `MAX_DRAFT_META_KEYS` drafts is the only multiplier, and
 * a member's draft count is their own to manage.
 */
export const MAX_DRAFT_META_BYTES = 8 * 1024;

/** How many keys one composer may park. */
export const MAX_DRAFT_META_KEYS = 32;

/** Longest key. Keys are identifiers a composer wrote, so a short cap. */
export const MAX_DRAFT_META_KEY_LENGTH = 64;

/**
 * Longest string value. 2048 matches `MAX_IMAGE_REFERENCE_LENGTH`, since the
 * longest legitimate value any composer stores is an image reference.
 *
 * Member PROSE never belongs here: the title and the body have their own
 * validated fields on the DTO, and `desc` is where a composer's long text goes.
 */
export const MAX_DRAFT_META_VALUE_LENGTH = 2048;

/** Longest string list (the forum's tag list is capped at five). */
export const MAX_DRAFT_META_ARRAY_LENGTH = 64;

/**
 * Keys that name something on `Object.prototype`. Assigning one of these while
 * rebuilding the object client-side is the classic prototype-pollution shape,
 * and no composer has any reason to use them.
 */
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype'];

/** Keys are composer-authored identifiers, so a plain identifier charset. */
const KEY_PATTERN = /^[A-Za-z0-9_]+$/;

function isValidKey(key: string): boolean {
  return (
    key.length > 0 &&
    key.length <= MAX_DRAFT_META_KEY_LENGTH &&
    KEY_PATTERN.test(key) &&
    !FORBIDDEN_KEYS.includes(key)
  );
}

function isValidValue(value: unknown): value is DraftMetaValue {
  if (value === null || typeof value === 'boolean') {
    return true;
  }
  if (typeof value === 'number') {
    // `NaN`/`Infinity` do not survive `JSON.stringify` (both become `null`), so
    // accepting them would persist something other than what was sent.
    return Number.isFinite(value);
  }
  if (typeof value === 'string') {
    return value.length <= MAX_DRAFT_META_VALUE_LENGTH;
  }
  if (Array.isArray(value)) {
    return (
      value.length <= MAX_DRAFT_META_ARRAY_LENGTH &&
      value.every(
        (entry) =>
          typeof entry === 'string' &&
          entry.length <= MAX_DRAFT_META_VALUE_LENGTH,
      )
    );
  }
  return false;
}

/** True when `value` is a well-formed, in-budget {@link DraftMeta}. */
export function isDraftMeta(value: unknown): value is DraftMeta {
  if (value === null) {
    return true;
  }
  if (typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  // `Object.keys` walks own enumerable keys only, so an inherited `__proto__`
  // is not counted; a literal one sent over JSON IS an own key and is refused
  // by `isValidKey`.
  const entries = value as Record<string, unknown>;
  const keys = Object.keys(entries);
  if (keys.length > MAX_DRAFT_META_KEYS) {
    return false;
  }
  for (const key of keys) {
    if (!isValidKey(key) || !isValidValue(entries[key])) {
      return false;
    }
  }
  // Size last: the cheap structural checks already rejected the shapes that
  // make serializing expensive (deep nesting cannot get here at all).
  const serialized = JSON.stringify(value);
  return (
    serialized !== undefined &&
    Buffer.byteLength(serialized, 'utf8') <= MAX_DRAFT_META_BYTES
  );
}

/**
 * A draft's `meta` is a FLAT, BOUNDED bag of composer state (see `DraftMeta`).
 *
 * The alternative, a bare `@IsObject()`, would accept any JSON a client cares
 * to send: arbitrary depth, megabytes of it, on a column that a composer
 * rewrites every 1.5 seconds while someone types. Shape-checking here means the
 * refusal is a 400 at the request boundary rather than a row nobody can explain
 * later.
 */
export function IsDraftMeta(validationOptions?: ValidationOptions) {
  return function registerOnProperty(object: object, propertyName: string) {
    registerDecorator({
      name: 'isDraftMeta',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown) {
          return isDraftMeta(value);
        },
        defaultMessage(args: ValidationArguments) {
          return `${args.property} must be a flat object of at most ${MAX_DRAFT_META_KEYS} keys whose values are strings, numbers, booleans, null or string arrays, under ${MAX_DRAFT_META_BYTES / 1024} KB serialized`;
        },
      },
    });
  };
}
