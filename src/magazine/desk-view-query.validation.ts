import { BadRequestException } from '@nestjs/common';
import { DeskViewQuery } from './entities/magazine-desk-view.entity';

/**
 * Pure validator for the `MagazineDeskView.query` jsonb column, hand-rolled in
 * the style of `piece-jsonb.validation.ts`. A saved view is desk URL state,
 * so every key is optional, unknown keys are refused (the column stays a
 * bounded, known shape), and every list and string is capped because the
 * whole blob is returned on every desk load.
 *
 * The closed value sets below mirror the frontend types they come from. When
 * the desk grows a new track, format, sort or grouping, add it here too, or
 * saving a view that uses it answers 400.
 */

/** `DeskTrack` in `desk/DeskTrackTabs.tsx`. */
export const DESK_VIEW_TRACKS = ['unassigned', 'issue', 'everything'] as const;
/** `PieceFormatFilter` in `desk/useDeskState.ts`. */
export const DESK_VIEW_FORMATS = ['all', 'article', 'deck'] as const;
/** `PieceSortOption` in `desk/useDeskState.ts`. */
export const DESK_VIEW_SORTS = ['due', 'stage', 'sec'] as const;
/** `DeskGroupBy` in `desk/pipelineGroups.ts`. */
export const DESK_VIEW_GROUPINGS = [
  'waiting',
  'stage',
  'section',
  'none',
] as const;

const ALLOWED_KEYS = new Set([
  'track',
  'focus',
  'format',
  'sections',
  'stages',
  'editor',
  'sort',
  'groupBy',
]);

// Well above any real desk: there are eleven focus chips (the desk's
// `DeskFocusId`), eight stages and about ten sections.
const MAX_LIST_ITEMS = 20;
const MAX_TEXT_LENGTH = 80;

function fail(reason: string): never {
  throw new BadRequestException(`query: ${reason}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readChoice(
  input: Record<string, unknown>,
  key: string,
  choices: readonly string[],
): string | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !choices.includes(value)) {
    fail(`${key} must be one of ${choices.join(', ')}`);
  }
  return value;
}

function readTextList(
  input: Record<string, unknown>,
  key: string,
): string[] | undefined {
  const value = input[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) {
    fail(`${key} must be an array of strings`);
  }
  if (value.length > MAX_LIST_ITEMS) {
    fail(`${key} holds at most ${MAX_LIST_ITEMS} entries`);
  }
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0) {
      fail(`${key} entries must be non-empty strings`);
    }
    if (entry.length > MAX_TEXT_LENGTH) {
      fail(`${key} entries are at most ${MAX_TEXT_LENGTH} characters`);
    }
  }
  return [...(value as string[])];
}

function readEditor(input: Record<string, unknown>): string | null | undefined {
  const value = input.editor;
  if (value === undefined || value === null) return value;
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_TEXT_LENGTH
  ) {
    fail('editor must be an editor id or null');
  }
  return value;
}

/**
 * Validates an `unknown` payload as a `DeskViewQuery` and returns a clean copy
 * holding only the keys that were present. Throws `BadRequestException` with
 * a field-path message on the first violation.
 */
export function validateDeskViewQuery(input: unknown): DeskViewQuery {
  if (!isRecord(input)) {
    fail('must be an object');
  }
  for (const key of Object.keys(input)) {
    if (!ALLOWED_KEYS.has(key)) {
      fail(`unknown key "${key}"`);
    }
  }

  const query: DeskViewQuery = {};
  const track = readChoice(input, 'track', DESK_VIEW_TRACKS);
  if (track !== undefined) query.track = track;
  const focus = readTextList(input, 'focus');
  if (focus !== undefined) query.focus = focus;
  const format = readChoice(input, 'format', DESK_VIEW_FORMATS);
  if (format !== undefined) query.format = format;
  const sections = readTextList(input, 'sections');
  if (sections !== undefined) query.sections = sections;
  const stages = readTextList(input, 'stages');
  if (stages !== undefined) query.stages = stages;
  const editor = readEditor(input);
  if (editor !== undefined) query.editor = editor;
  const sort = readChoice(input, 'sort', DESK_VIEW_SORTS);
  if (sort !== undefined) query.sort = sort;
  const groupBy = readChoice(input, 'groupBy', DESK_VIEW_GROUPINGS);
  if (groupBy !== undefined) query.groupBy = groupBy;
  return query;
}
