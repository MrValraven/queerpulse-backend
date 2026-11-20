/**
 * Guide section and checklist step rules (contract 8.1), and the due day
 * arithmetic that turns a step into a task (contract 7.5), as pure functions.
 *
 * Every refusal goes through `culturalError` with the indexes the contract
 * names, and no message carries the text it refused.
 */
import { randomUUID } from 'node:crypto';
import { isUUID } from 'class-validator';
import { codePointLength, normalizeCulturalText } from './cultural-text';
import {
  CULTURAL_GUIDE_BODY_MAX,
  CULTURAL_GUIDE_HEADING_MAX,
  CULTURAL_GUIDE_SECTIONS_MAX,
  CULTURAL_GUIDE_SECTION_STEPS_MAX,
  CULTURAL_GUIDE_STEPS_MAX,
  CULTURAL_STEP_DAYS_MAX,
  CULTURAL_STEP_DAYS_MIN,
  CULTURAL_TITLE_MAX,
  culturalError,
} from './cultural-production.constants';
import type {
  CulturalGuideSectionRecord,
  CulturalGuideStepRecord,
} from './cultural-production.constants';

/** The milliseconds in one calendar day. */
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Checks a submitted `sections` value in the contract 8.1 order, first
 * failure answers: no array, more than 30 sections, then each section in
 * order (shape, heading, body, steps, then each step's shape, text and
 * days), then more than 100 steps across the guide. A section or step keeps
 * its `id` when it is a uuid string not yet used in this guide (lowercased);
 * any other id is replaced with a fresh uuid. Unknown keys are dropped and
 * the order is kept.
 */
export function normalizeCulturalGuideSections(
  value: unknown,
): CulturalGuideSectionRecord[] {
  if (!Array.isArray(value)) {
    throw culturalError('CULTURAL_GUIDE_SECTIONS_INVALID');
  }
  if (value.length > CULTURAL_GUIDE_SECTIONS_MAX) {
    throw culturalError('CULTURAL_GUIDE_TOO_MANY_SECTIONS');
  }
  const usedIds = new Set<string>();
  const sections = value.map((section: unknown, sectionIndex) =>
    normalizeSection(section, sectionIndex, usedIds),
  );
  if (countGuideSteps(sections) > CULTURAL_GUIDE_STEPS_MAX) {
    throw culturalError('CULTURAL_GUIDE_TOO_MANY_STEPS');
  }
  return sections;
}

/** The number of checklist steps across every section of a guide. */
export function countGuideSteps(
  sections: readonly Pick<CulturalGuideSectionRecord, 'steps'>[],
): number {
  return sections.reduce(
    (stepTotal, section) => stepTotal + section.steps.length,
    0,
  );
}

/**
 * The due day of a task made from a step: `null` when the step has no
 * `daysBefore`, else `eventOn` minus `daysBefore` calendar days. The
 * arithmetic runs in UTC on the `YYYY-MM-DD` text, so no time zone or
 * daylight saving shift can move the day. A negative `daysBefore` lands
 * after the event: `-1` is the day after.
 */
export function dueOnForStep(
  eventOn: string,
  daysBefore: number | null,
): string | null {
  if (daysBefore === null) return null;
  const eventMilliseconds = Date.parse(`${eventOn}T00:00:00Z`);
  const dueMilliseconds = eventMilliseconds - daysBefore * MILLISECONDS_PER_DAY;
  return new Date(dueMilliseconds).toISOString().slice(0, 10);
}

function normalizeSection(
  value: unknown,
  sectionIndex: number,
  usedIds: Set<string>,
): CulturalGuideSectionRecord {
  if (!isPlainObject(value)) {
    throw culturalError('CULTURAL_GUIDE_SECTIONS_INVALID', { sectionIndex });
  }
  const id = claimId(value.id, usedIds);
  const heading = normalizeHeading(value.heading, sectionIndex);
  const body = normalizeBody(value.body, sectionIndex);
  const rawSteps = value.steps ?? [];
  if (!Array.isArray(rawSteps)) {
    throw culturalError('CULTURAL_GUIDE_SECTIONS_INVALID', { sectionIndex });
  }
  if (rawSteps.length > CULTURAL_GUIDE_SECTION_STEPS_MAX) {
    throw culturalError('CULTURAL_GUIDE_TOO_MANY_STEPS', { sectionIndex });
  }
  const steps = rawSteps.map((step: unknown, stepIndex) =>
    normalizeStep(step, sectionIndex, stepIndex, usedIds),
  );
  return { id, heading, body, steps };
}

function normalizeStep(
  value: unknown,
  sectionIndex: number,
  stepIndex: number,
  usedIds: Set<string>,
): CulturalGuideStepRecord {
  if (!isPlainObject(value)) {
    throw culturalError('CULTURAL_GUIDE_SECTIONS_INVALID', {
      sectionIndex,
      stepIndex,
    });
  }
  const id = claimId(value.id, usedIds);
  const text = normalizeStepText(value.text, sectionIndex, stepIndex);
  const daysBefore = normalizeDaysBefore(
    value.daysBefore,
    sectionIndex,
    stepIndex,
  );
  return { id, text, daysBefore };
}

function normalizeHeading(value: unknown, sectionIndex: number): string {
  if (typeof value !== 'string') {
    throw culturalError('CULTURAL_GUIDE_HEADING_REQUIRED', { sectionIndex });
  }
  const heading = normalizeCulturalText(value);
  if (!heading) {
    throw culturalError('CULTURAL_GUIDE_HEADING_REQUIRED', { sectionIndex });
  }
  if (codePointLength(heading) > CULTURAL_GUIDE_HEADING_MAX) {
    throw culturalError('CULTURAL_GUIDE_HEADING_TOO_LONG', { sectionIndex });
  }
  return heading;
}

// Absent or null reads as an empty body. Inner blank lines stay, since they
// separate paragraphs in the body format of contract 8.2.
function normalizeBody(value: unknown, sectionIndex: number): string {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') {
    throw culturalError('CULTURAL_GUIDE_BODY_TOO_LONG', { sectionIndex });
  }
  const body = normalizeCulturalText(value);
  if (codePointLength(body) > CULTURAL_GUIDE_BODY_MAX) {
    throw culturalError('CULTURAL_GUIDE_BODY_TOO_LONG', { sectionIndex });
  }
  return body;
}

function normalizeStepText(
  value: unknown,
  sectionIndex: number,
  stepIndex: number,
): string {
  if (typeof value !== 'string') {
    throw culturalError('CULTURAL_GUIDE_STEP_TEXT_REQUIRED', {
      sectionIndex,
      stepIndex,
    });
  }
  const text = normalizeCulturalText(value);
  if (!text) {
    throw culturalError('CULTURAL_GUIDE_STEP_TEXT_REQUIRED', {
      sectionIndex,
      stepIndex,
    });
  }
  if (codePointLength(text) > CULTURAL_TITLE_MAX) {
    throw culturalError('CULTURAL_GUIDE_STEP_TEXT_TOO_LONG', {
      sectionIndex,
      stepIndex,
    });
  }
  return text;
}

function normalizeDaysBefore(
  value: unknown,
  sectionIndex: number,
  stepIndex: number,
): number | null {
  if (value === undefined || value === null) return null;
  const isValid =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= CULTURAL_STEP_DAYS_MIN &&
    value <= CULTURAL_STEP_DAYS_MAX;
  if (!isValid) {
    throw culturalError('CULTURAL_GUIDE_STEP_DAYS_INVALID', {
      sectionIndex,
      stepIndex,
    });
  }
  // `-0` is stored as `0`, so the jsonb never carries a signed zero.
  return value === 0 ? 0 : value;
}

// One id namespace per guide: sections and steps share it, the first use of
// an id keeps it, and every later use gets a fresh uuid.
function claimId(value: unknown, usedIds: Set<string>): string {
  const candidate =
    typeof value === 'string' && isUUID(value) ? value.toLowerCase() : null;
  const id =
    candidate !== null && !usedIds.has(candidate) ? candidate : randomUUID();
  usedIds.add(id);
  return id;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return false;
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
