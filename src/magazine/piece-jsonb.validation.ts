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
    if (!isString(record[field])) {
      failBrief(`${field} must be a string`);
    }
  }

  if (!isStringArray(record.wants)) {
    failBrief('wants must be an array of strings');
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
  record.subjects.forEach((subject, index) =>
    assertCareSubject(subject, index),
  );

  if (!isStringArray(record.contentNotes)) {
    failCare('contentNotes must be an array of strings');
  }

  if (!Array.isArray(record.flags)) {
    failCare('flags must be an array');
  }
  record.flags.forEach((flag, index) => validateCareFlag(flag, index));

  validateCareRead(record.read);

  return input as unknown as PieceCare;
}
