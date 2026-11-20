/**
 * Field rules of the Cultural Production routes (contract 7.2), as pure
 * functions.
 *
 * The services run these before any query, so a CHECK violation never
 * reaches the driver with a row in its error text. Each function answers the
 * contract's reason code through `culturalError`, in the contract's check
 * order, and no message carries the value it refused. Shape checks live here;
 * whether a linked idea, guide or assignee exists is the service's question.
 */
import { HttpStatus } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { isRealCalendarDay } from '../leads/lead-cursor';
import { normalizeCulturalGuideSections } from './cultural-guide-sections';
import {
  CULTURAL_COMMENT_MAX,
  CULTURAL_DATE_MAX,
  CULTURAL_DATE_MIN,
  CULTURAL_GUIDE_SUMMARY_MAX,
  CULTURAL_IDEA_DESCRIPTION_MAX,
  CULTURAL_MAX_ASSIGNEES,
  CULTURAL_TASK_NOTES_MAX,
  CULTURAL_TITLE_MAX,
  DEFAULT_CULTURAL_IDEA_STATUS,
  DEFAULT_CULTURAL_TASK_STATUS,
  culturalError,
  isCulturalAssignedToFilter,
  isCulturalEventType,
  isCulturalGuideLocale,
  isCulturalIdeaStatus,
  isCulturalTaskStatus,
  isCulturalTaskStatusFilter,
} from './cultural-production.constants';
import type {
  CulturalAssignedToFilter,
  CulturalEventType,
  CulturalGuideLocale,
  CulturalGuideSectionRecord,
  CulturalIdeaStatus,
  CulturalRefusalCode,
  CulturalTaskStatus,
  CulturalTaskStatusFilter,
} from './cultural-production.constants';
import type {
  CreateCulturalGuideDto,
  CreateCulturalIdeaDto,
  CreateCulturalTaskDto,
  ListCulturalTasksQuery,
  ReplaceCulturalGuideDto,
  UpdateCulturalIdeaDto,
  UpdateCulturalTaskDto,
} from './dto/cultural-production.dto';
import { codePointLength, normalizeCulturalText } from './cultural-text';

/** The text rule of contract 7.2, kept in `cultural-text.ts` and exported
 *  here for the services. */
export { normalizeCulturalText } from './cultural-text';

/** The staff picker search rule of the leads routes: no string or blank
 *  gives `''`, a long one is cut to 100 code points. It never refuses. */
export { normalizeSearchTerm } from '../leads/lead-input';

/** An idea create body after every field check passed. */
export interface NormalizedIdeaCreate {
  title: string;
  description: string;
  eventType: CulturalEventType;
  status: CulturalIdeaStatus;
}

/** A task create body after every shape check passed. `ideaId`, `guideId`
 *  and each assignee id are lowercased uuids whose rows the service still
 *  has to find. */
export interface NormalizedTaskCreate {
  title: string;
  notes: string;
  status: CulturalTaskStatus;
  /** A `YYYY-MM-DD` day, or `null` for no due date. */
  dueOn: string | null;
  ideaId: string | null;
  guideId: string | null;
  /** Distinct, lowercased, in first-seen order, at most 10. */
  assigneeIds: string[];
}

/** A guide create or replace body after every field check passed. */
export interface NormalizedGuide {
  title: string;
  eventType: CulturalEventType;
  locale: CulturalGuideLocale;
  summary: string;
  sections: CulturalGuideSectionRecord[];
}

/** The task list filters after their checks. `null` means no filter. */
export interface CulturalTaskFilters {
  assignedTo: CulturalAssignedToFilter | null;
  status: CulturalTaskStatusFilter | null;
}

/** The largest value a Postgres `integer` column holds. A larger revision
 *  would turn the guarded update into a 500. */
const POSTGRES_INTEGER_MAX = 2_147_483_647;

/** An idea, task or guide title: missing, no string or blank answers
 *  `CULTURAL_TITLE_REQUIRED`; over 160 code points answers
 *  `CULTURAL_TITLE_TOO_LONG`. */
export function normalizeCulturalTitle(value: unknown): string {
  if (typeof value !== 'string') {
    throw culturalError('CULTURAL_TITLE_REQUIRED');
  }
  const title = normalizeCulturalText(value);
  if (!title) {
    throw culturalError('CULTURAL_TITLE_REQUIRED');
  }
  if (codePointLength(title) > CULTURAL_TITLE_MAX) {
    throw culturalError('CULTURAL_TITLE_TOO_LONG');
  }
  return title;
}

/** Checks an idea create body in the contract order: title, description,
 *  eventType, status. An absent description reads `''` and an absent status
 *  takes `new`. */
export function normalizeIdeaCreate(
  body: CreateCulturalIdeaDto,
): NormalizedIdeaCreate {
  const title = normalizeCulturalTitle(body.title);
  const description =
    body.description === undefined
      ? ''
      : normalizeDescription(body.description);
  const eventType = normalizeEventType(body.eventType);
  const status =
    body.status === undefined
      ? DEFAULT_CULTURAL_IDEA_STATUS
      : normalizeIdeaStatus(body.status);
  return { title, description, eventType, status };
}

/** Checks each present field of an idea update body in the create order. An
 *  absent property stays out of the answer, so a body with no known field
 *  answers `{}`. A `null` description clears it. */
export function normalizeIdeaUpdate(
  body: UpdateCulturalIdeaDto,
): Partial<NormalizedIdeaCreate> {
  const changes: Partial<NormalizedIdeaCreate> = {};
  if (body.title !== undefined) {
    changes.title = normalizeCulturalTitle(body.title);
  }
  if (body.description !== undefined) {
    changes.description = normalizeDescription(body.description);
  }
  if (body.eventType !== undefined) {
    changes.eventType = normalizeEventType(body.eventType);
  }
  if (body.status !== undefined) {
    changes.status = normalizeIdeaStatus(body.status);
  }
  return changes;
}

/** A comment body: missing, no string or blank answers
 *  `CULTURAL_COMMENT_EMPTY`; over 2000 code points answers
 *  `CULTURAL_COMMENT_TOO_LONG`. Inner line breaks stay. */
export function normalizeCommentBody(value: unknown): string {
  if (typeof value !== 'string') {
    throw culturalError('CULTURAL_COMMENT_EMPTY');
  }
  const body = normalizeCulturalText(value);
  if (!body) {
    throw culturalError('CULTURAL_COMMENT_EMPTY');
  }
  if (codePointLength(body) > CULTURAL_COMMENT_MAX) {
    throw culturalError('CULTURAL_COMMENT_TOO_LONG');
  }
  return body;
}

/** Checks a task create body in the contract order: title, notes, status,
 *  dueOn, ideaId shape, guideId shape, assigneeIds shape and count. Absent
 *  notes read `''`, an absent status takes `todo`, and an absent due date,
 *  idea or guide reads `null`. */
export function normalizeTaskCreate(
  body: CreateCulturalTaskDto,
): NormalizedTaskCreate {
  const title = normalizeCulturalTitle(body.title);
  const notes = body.notes === undefined ? '' : normalizeNotes(body.notes);
  const status =
    body.status === undefined
      ? DEFAULT_CULTURAL_TASK_STATUS
      : normalizeTaskStatus(body.status);
  const dueOn =
    body.dueOn === undefined
      ? null
      : normalizeCulturalDay(body.dueOn, 'CULTURAL_DUE_DATE_INVALID', {
          isNullable: true,
        });
  const ideaId =
    normalizeOptionalUuid(body.ideaId, 'CULTURAL_LINKED_IDEA_NOT_FOUND') ??
    null;
  const guideId =
    normalizeOptionalUuid(body.guideId, 'CULTURAL_LINKED_GUIDE_NOT_FOUND') ??
    null;
  const assigneeIds = normalizeAssigneeIds(body.assigneeIds);
  return { title, notes, status, dueOn, ideaId, guideId, assigneeIds };
}

/** Checks each present field of a task update body in the create order.
 *  Assignees never change through an update. An absent property stays out
 *  of the answer; `null` clears `notes`, `dueOn`, `ideaId` and `guideId`. */
export function normalizeTaskUpdate(
  body: UpdateCulturalTaskDto,
): Partial<Omit<NormalizedTaskCreate, 'assigneeIds'>> {
  const changes: Partial<Omit<NormalizedTaskCreate, 'assigneeIds'>> = {};
  if (body.title !== undefined) {
    changes.title = normalizeCulturalTitle(body.title);
  }
  if (body.notes !== undefined) changes.notes = normalizeNotes(body.notes);
  if (body.status !== undefined) {
    changes.status = normalizeTaskStatus(body.status);
  }
  if (body.dueOn !== undefined) {
    changes.dueOn = normalizeCulturalDay(
      body.dueOn,
      'CULTURAL_DUE_DATE_INVALID',
      { isNullable: true },
    );
  }
  const ideaId = normalizeOptionalUuid(
    body.ideaId,
    'CULTURAL_LINKED_IDEA_NOT_FOUND',
  );
  if (ideaId !== undefined) changes.ideaId = ideaId;
  const guideId = normalizeOptionalUuid(
    body.guideId,
    'CULTURAL_LINKED_GUIDE_NOT_FOUND',
  );
  if (guideId !== undefined) changes.guideId = guideId;
  return changes;
}

/** Checks an `assigneeIds` body list. Absent reads `[]`. No array, or an
 *  item that is no uuid string, answers 400 `CULTURAL_ASSIGNEE_NOT_FOUND`
 *  (the refusal carries no `userId`, since the value is no id). Ids are
 *  lowercased and duplicates collapse, first one kept; more than 10 distinct
 *  answers 400 `CULTURAL_TOO_MANY_ASSIGNEES`. */
export function normalizeAssigneeIds(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(isCulturalUuid)) {
    throw culturalError('CULTURAL_ASSIGNEE_NOT_FOUND', {
      status: HttpStatus.BAD_REQUEST,
    });
  }
  const distinctIds = [...new Set(value.map((userId) => userId.toLowerCase()))];
  if (distinctIds.length > CULTURAL_MAX_ASSIGNEES) {
    throw culturalError('CULTURAL_TOO_MANY_ASSIGNEES', {
      status: HttpStatus.BAD_REQUEST,
    });
  }
  return distinctIds;
}

/** Checks the task list query in the order assignedTo, status. Absent or
 *  blank after trim means no filter; a repeated value arrives as an array
 *  and is refused like any unknown one. */
export function normalizeTaskFilters(
  query: ListCulturalTasksQuery,
): CulturalTaskFilters {
  const assignedToCandidate = trimmedIfText(query.assignedTo);
  let assignedTo: CulturalAssignedToFilter | null = null;
  if (assignedToCandidate !== undefined && assignedToCandidate !== '') {
    if (!isCulturalAssignedToFilter(assignedToCandidate)) {
      throw culturalError('CULTURAL_ASSIGNED_TO_INVALID');
    }
    assignedTo = assignedToCandidate;
  }
  const statusCandidate = trimmedIfText(query.status);
  let status: CulturalTaskStatusFilter | null = null;
  if (statusCandidate !== undefined && statusCandidate !== '') {
    if (!isCulturalTaskStatusFilter(statusCandidate)) {
      throw culturalError('CULTURAL_TASK_STATUS_INVALID');
    }
    status = statusCandidate;
  }
  return { assignedTo, status };
}

/** A due or event day: a `YYYY-MM-DD` string (trimmed) that round-trips as
 *  a real day from 2000-01-01 to 2100-12-31. `null` reads as a clear when
 *  `isNullable`; anything else answers `code`. */
export function normalizeCulturalDay(
  value: unknown,
  code: 'CULTURAL_DUE_DATE_INVALID' | 'CULTURAL_EVENT_DATE_INVALID',
  { isNullable }: { isNullable: boolean },
): string | null {
  if (value === null && isNullable) return null;
  const day = trimmedIfText(value);
  // Both bounds and the day are `YYYY-MM-DD`, so text order is day order.
  const isValid =
    typeof day === 'string' &&
    isRealCalendarDay(day) &&
    day >= CULTURAL_DATE_MIN &&
    day <= CULTURAL_DATE_MAX;
  if (!isValid) {
    throw culturalError(code);
  }
  return day;
}

/** An optional uuid body field: `undefined` when absent, `null` when sent
 *  as `null` (a clear), else the lowercased uuid. Anything else answers
 *  `code` with its table status. */
export function normalizeOptionalUuid(
  value: unknown,
  code: CulturalRefusalCode,
): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (!isCulturalUuid(value)) {
    throw culturalError(code);
  }
  return value.toLowerCase();
}

/** Whether `value` is a uuid string, in any letter case. The services check
 *  every path id with it before any query. */
export function isCulturalUuid(value: unknown): value is string {
  return typeof value === 'string' && isUUID(value);
}

/** Checks a guide create body in the contract order: title, eventType,
 *  locale, summary, sections. An absent summary reads `''` and absent
 *  sections read `[]`. */
export function normalizeGuideCreate(
  body: CreateCulturalGuideDto,
): NormalizedGuide {
  const title = normalizeCulturalTitle(body.title);
  const eventType = normalizeEventType(body.eventType);
  const locale = normalizeGuideLocale(body.locale);
  const summary =
    body.summary === undefined ? '' : normalizeGuideSummary(body.summary);
  const sections =
    body.sections === undefined
      ? []
      : normalizeCulturalGuideSections(body.sections);
  return { title, eventType, locale, summary, sections };
}

/** Checks a guide replace body in the contract order: revision, title,
 *  eventType, locale, summary, sections. `revision` must be an integer of
 *  at least 1 (`CULTURAL_GUIDE_REVISION_INVALID`), and `sections` is
 *  required. */
export function normalizeGuideReplace(
  body: ReplaceCulturalGuideDto,
): NormalizedGuide & { revision: number } {
  const revision = normalizeGuideRevision(body.revision);
  const title = normalizeCulturalTitle(body.title);
  const eventType = normalizeEventType(body.eventType);
  const locale = normalizeGuideLocale(body.locale);
  const summary =
    body.summary === undefined ? '' : normalizeGuideSummary(body.summary);
  const sections = normalizeCulturalGuideSections(body.sections);
  return { revision, title, eventType, locale, summary, sections };
}

// Strings are trimmed before an enum check, so `' party '` reads as
// `party`. Any other value passes through untouched and fails the guard.
function trimmedIfText(value: unknown): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

// Description, notes and summary: `null` reads `''`; no string or over the
// limit answers the field's one code.
function normalizeLongText(
  value: unknown,
  maxLength: number,
  code: CulturalRefusalCode,
): string {
  if (value === null) return '';
  if (typeof value !== 'string') {
    throw culturalError(code);
  }
  const text = normalizeCulturalText(value);
  if (codePointLength(text) > maxLength) {
    throw culturalError(code);
  }
  return text;
}

function normalizeDescription(value: unknown): string {
  return normalizeLongText(
    value,
    CULTURAL_IDEA_DESCRIPTION_MAX,
    'CULTURAL_DESCRIPTION_TOO_LONG',
  );
}

function normalizeNotes(value: unknown): string {
  return normalizeLongText(
    value,
    CULTURAL_TASK_NOTES_MAX,
    'CULTURAL_NOTES_TOO_LONG',
  );
}

function normalizeGuideSummary(value: unknown): string {
  return normalizeLongText(
    value,
    CULTURAL_GUIDE_SUMMARY_MAX,
    'CULTURAL_GUIDE_SUMMARY_TOO_LONG',
  );
}

function normalizeEventType(value: unknown): CulturalEventType {
  const candidate = trimmedIfText(value);
  if (!isCulturalEventType(candidate)) {
    throw culturalError('CULTURAL_EVENT_TYPE_INVALID');
  }
  return candidate;
}

function normalizeIdeaStatus(value: unknown): CulturalIdeaStatus {
  const candidate = trimmedIfText(value);
  if (!isCulturalIdeaStatus(candidate)) {
    throw culturalError('CULTURAL_IDEA_STATUS_INVALID');
  }
  return candidate;
}

function normalizeTaskStatus(value: unknown): CulturalTaskStatus {
  const candidate = trimmedIfText(value);
  if (!isCulturalTaskStatus(candidate)) {
    throw culturalError('CULTURAL_TASK_STATUS_INVALID');
  }
  return candidate;
}

function normalizeGuideLocale(value: unknown): CulturalGuideLocale {
  const candidate = trimmedIfText(value);
  if (!isCulturalGuideLocale(candidate)) {
    throw culturalError('CULTURAL_GUIDE_LOCALE_INVALID');
  }
  return candidate;
}

function normalizeGuideRevision(value: unknown): number {
  const isValid =
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 1 &&
    value <= POSTGRES_INTEGER_MAX;
  if (!isValid) {
    throw culturalError('CULTURAL_GUIDE_REVISION_INVALID');
  }
  return value;
}
