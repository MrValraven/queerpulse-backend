import type { DecodedPlatformLogCursor } from './platform-log.types';

const EXACT_TIME_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SEPARATOR = '|';

export function encodePlatformLogCursor(key: DecodedPlatformLogCursor): string {
  return Buffer.from(
    [key.occurredAtExact, key.sourceKey, key.rowId].join(SEPARATOR),
  ).toString('base64');
}

/** Any cursor that does not decode cleanly reads as "first page". */
export function decodePlatformLogCursor(
  cursor: string | undefined,
): DecodedPlatformLogCursor | null {
  if (!cursor) return null;
  const parts = Buffer.from(cursor, 'base64').toString('utf8').split(SEPARATOR);
  if (parts.length !== 3) return null;
  const [occurredAtExact = '', sourceKey = '', rowId = ''] = parts;
  if (!EXACT_TIME_PATTERN.test(occurredAtExact) || !sourceKey || !rowId) {
    return null;
  }
  return { occurredAtExact, sourceKey, rowId };
}

function compareText(first: string, second: string): number {
  if (first < second) return -1;
  if (first > second) return 1;
  return 0;
}

/**
 * Sort comparator for the merged page: `(occurredAtExact, sourceKey, rowId)`,
 * all descending. Plain code-unit comparison matches Postgres `COLLATE "C"`,
 * which every source uses for its row-id ordering.
 */
export function compareNewestFirst(
  first: DecodedPlatformLogCursor,
  second: DecodedPlatformLogCursor,
): number {
  return (
    compareText(second.occurredAtExact, first.occurredAtExact) ||
    compareText(second.sourceKey, first.sourceKey) ||
    compareText(second.rowId, first.rowId)
  );
}
