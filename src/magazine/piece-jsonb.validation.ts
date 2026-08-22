import { BadRequestException } from '@nestjs/common';
import {
  PieceBrief,
  PieceCare,
  PieceCareSubject,
} from './entities/magazine-piece.entity';

/**
 * Pure validators for the `MagazinePiece.brief`/`.care` JSONB columns. No
 * discriminated-union DTO validation exists elsewhere in the repo for these
 * shapes, so this hand-rolls a field-by-field check (mirroring
 * `deck-slides.validation.ts`) and throws `BadRequestException` with a
 * field-path message on the first violation. Called by the service on
 * create/update, before `save()`. Both columns are nullable, so both
 * functions accept a top-level `null` and pass it straight through —
 * the service can call them unconditionally without a pre-check.
 */

const CONSENT_VALUES = ['given', 'pending', 'pseudonym'] as const;

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isStringIfPresent(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === 'boolean';
}

function isNumberOrNull(value: unknown): boolean {
  return value === null || typeof value === 'number';
}

function isBooleanOrNull(value: unknown): boolean {
  return value === null || typeof value === 'boolean';
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === 'string')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function failBrief(reason: string): never {
  throw new BadRequestException(`brief: ${reason}`);
}

function failCare(reason: string): never {
  throw new BadRequestException(`care: ${reason}`);
}

// Size ceilings for the two jsonb columns on `magazine_piece`. Both are
// rewritten in full on every desk save and returned by every
// `getPieceRecordFull`/board load, so an unbounded blob is paid for on every
// read, not just once. Set well above any real commission — a brief has a
// handful of "wants", a care record a handful of subjects and flags.
const MAX_JSONB_ITEMS = 50;
const MAX_JSONB_TEXT_LENGTH = 5_000;

/**
 * Validates an `unknown` payload as a `PieceBrief`: required string fields
 * (`angle`, `avoid`, `rate`, `killFee`, `commissionedBy`, `commissionedOn`,
 * `art`), a `wants` string array, and `wordCount`/`filedWords` as
 * number-or-null. `null` is passed through unchanged (the entity column is
 * nullable; the service calls this unconditionally). Throws
 * `BadRequestException` on any other malformed shape.
 */
export function validatePieceBrief(input: unknown): PieceBrief | null {
  if (input === null) {
    return null;
  }
  if (!isRecord(input)) {
    failBrief('must be an object');
  }
  const record = input;

  for (const field of [
    'angle',
    'avoid',
    'rate',
    'killFee',
    'commissionedBy',
    'commissionedOn',
    'art',
  ] as const) {
    const fieldValue = record[field];
    if (!isString(fieldValue)) {
      failBrief(`${field} must be a string`);
    }
    if (fieldValue.length > MAX_JSONB_TEXT_LENGTH) {
      failBrief(`${field} must be at most ${MAX_JSONB_TEXT_LENGTH} characters`);
    }
  }

  const wants = record.wants;
  if (!isStringArray(wants)) {
    failBrief('wants must be an array of strings');
  }
  if (wants.length > MAX_JSONB_ITEMS) {
    failBrief(`wants can have at most ${MAX_JSONB_ITEMS} entries`);
  }
  if (wants.some((want) => want.length > MAX_JSONB_TEXT_LENGTH)) {
    failBrief(`each want must be at most ${MAX_JSONB_TEXT_LENGTH} characters`);
  }

  if (!isNumberOrNull(record.wordCount)) {
    failBrief('wordCount must be a number or null');
  }
  if (!isNumberOrNull(record.filedWords)) {
    failBrief('filedWords must be a number or null');
  }

  return input as unknown as PieceBrief;
}

function assertCareSubject(
  value: unknown,
  index: number,
): asserts value is PieceCareSubject {
  if (!isRecord(value)) {
    failCare(`subjects[${index}] must be an object`);
  }
  const subject = value;

  if (!isString(subject.name)) {
    failCare(`subjects[${index}].name must be a string`);
  }
  if (!isBoolean(subject.named)) {
    failCare(`subjects[${index}].named must be a boolean`);
  }
  if (!isBooleanOrNull(subject.out)) {
    failCare(`subjects[${index}].out must be a boolean or null`);
  }
  if (
    typeof subject.consent !== 'string' ||
    !(CONSENT_VALUES as readonly string[]).includes(subject.consent)
  ) {
    failCare(
      `subjects[${index}].consent must be one of ${CONSENT_VALUES.join(', ')}`,
    );
  }
  if (!isString(subject.reply)) {
    failCare(`subjects[${index}].reply must be a string`);
  }
  if (!isString(subject.note)) {
    failCare(`subjects[${index}].note must be a string`);
  }
}

function validateCareFlag(value: unknown, index: number): void {
  if (!isRecord(value)) {
    failCare(`flags[${index}] must be an object`);
  }
  const flag = value;

  if (!isString(flag.key)) {
    failCare(`flags[${index}].key must be a string`);
  }
  if (!isBoolean(flag.on)) {
    failCare(`flags[${index}].on must be a boolean`);
  }
  if (!isString(flag.note)) {
    failCare(`flags[${index}].note must be a string`);
  }
}

function validateReadCheck(value: unknown, index: number): void {
  if (!isRecord(value)) {
    failCare(`read.checks[${index}] must be an object`);
  }
  const check = value;

  if (!isString(check.label)) {
    failCare(`read.checks[${index}].label must be a string`);
  }
  if (!isBoolean(check.done)) {
    failCare(`read.checks[${index}].done must be a boolean`);
  }
}

function validateCareRead(value: unknown): void {
  if (value === null) {
    return;
  }
  if (!isRecord(value)) {
    failCare('read must be an object or null');
  }
  const read = value;

  if (!isStringIfPresent(read.readerId)) {
    failCare('read.readerId must be a string if present');
  }
  for (const field of [
    'reader',
    'role',
    'status',
    'askedOn',
    'dueOn',
  ] as const) {
    if (!isString(read[field])) {
      failCare(`read.${field} must be a string`);
    }
  }
  if (!Array.isArray(read.checks)) {
    failCare('read.checks must be an array');
  }
  read.checks.forEach((check, index) => validateReadCheck(check, index));
}

/**
 * Validates an `unknown` payload as a `PieceCare`: `subjects` (each a valid
 * `PieceCareSubject`, `consent` in the `given`/`pending`/`pseudonym` union),
 * `contentNotes` as a string array, `flags` (each `{key,on,note}`), and
 * `read` as either `null` or a full read record. The top-level `input` is
 * also passed through unchanged when `null` (the entity column is nullable;
 * the service calls this unconditionally). Throws `BadRequestException` on
 * any other malformed shape.
 */
export function validatePieceCare(input: unknown): PieceCare | null {
  if (input === null) {
    return null;
  }
  if (!isRecord(input)) {
    failCare('must be an object');
  }
  const record = input;

  if (!Array.isArray(record.subjects)) {
    failCare('subjects must be an array');
  }
  if (record.subjects.length > MAX_JSONB_ITEMS) {
    failCare(`subjects can have at most ${MAX_JSONB_ITEMS} entries`);
  }
  record.subjects.forEach((subject, index) =>
    assertCareSubject(subject, index),
  );

  const contentNotes = record.contentNotes;
  if (!isStringArray(contentNotes)) {
    failCare('contentNotes must be an array of strings');
  }
  if (contentNotes.length > MAX_JSONB_ITEMS) {
    failCare(`contentNotes can have at most ${MAX_JSONB_ITEMS} entries`);
  }
  if (contentNotes.some((note) => note.length > MAX_JSONB_TEXT_LENGTH)) {
    failCare(
      `each content note must be at most ${MAX_JSONB_TEXT_LENGTH} characters`,
    );
  }

  if (!Array.isArray(record.flags)) {
    failCare('flags must be an array');
  }
  if (record.flags.length > MAX_JSONB_ITEMS) {
    failCare(`flags can have at most ${MAX_JSONB_ITEMS} entries`);
  }
  record.flags.forEach((flag, index) => validateCareFlag(flag, index));

  validateCareRead(record.read);

  return input as unknown as PieceCare;
}
