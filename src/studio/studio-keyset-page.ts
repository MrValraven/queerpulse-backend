import {
  StudioReleaseCursor,
  decodeStudioCursor,
  encodeStudioCursor,
} from './studio-cursor';
import { StudioPage } from './studio-response';

/*
 * Studio discovery: the keyset paging the raw-SQL page reads share (the
 * staff scene releases in Task 9, "Appears on" in Task 13). Each read binds
 * the cursor position as two parameters (a timestamp and an id, or two
 * nulls for the first page) and asks for one row past the page size, which
 * only says that more exist.
 */

/** The cursor's position as the two bound parameters; a missing or
 *  malformed cursor reads as the first page. */
export function keysetCursorParameters(
  cursor: string | undefined,
): [Date | null, string | null] {
  const decodedCursor = decodeStudioCursor(cursor);
  return [decodedCursor?.publishedAt ?? null, decodedCursor?.id ?? null];
}

/**
 * One page from rows read with `LIMIT pageSize + 1`. `positionOf` reads a
 * row's cursor position. `toItems` maps the page rows and may drop some (a
 * card that could not be built); the next cursor still follows the last
 * page row, so a dropped row never repeats or hides the rows after it.
 */
export async function toKeysetPage<Row, Item>(
  rows: Row[],
  pageSize: number,
  positionOf: (row: Row) => StudioReleaseCursor,
  toItems: (pageRows: Row[]) => Promise<Item[]>,
): Promise<StudioPage<Item>> {
  const hasMore = rows.length > pageSize;
  const pageRows = hasMore ? rows.slice(0, pageSize) : rows;
  const lastRow = pageRows[pageRows.length - 1];
  return {
    items: await toItems(pageRows),
    pageInfo: {
      hasMore,
      nextCursor:
        hasMore && lastRow ? encodeStudioCursor(positionOf(lastRow)) : null,
    },
  };
}
