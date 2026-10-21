import { STUDIO_LIMITS } from './studio.constants';

/*
 * ENG-05: a single-type search (`GET /studio/search?type=tracks`) pages
 * past its first 20 rows. Search orders by relevance-free sort keys of four
 * different shapes (release date, track position, display name, playlist
 * update), so the cursor is an opaque row offset rather than a keyset. A
 * match that lands between two page reads may shift a row by one; the
 * client removes duplicates by id, so a repeat never renders twice.
 */

/** Deepest row a search page may start at: 50 pages of 20. A cursor past
 *  it is never emitted, and a crafted one reads as the first page. */
export const STUDIO_SEARCH_MAX_OFFSET = 1000;

const CURSOR_PREFIX = 'search|';

/** Where one search page starts and how many rows it holds. `isPaged`
 *  reads one row past the page, which only says that more exist. */
export interface StudioSearchWindow {
  offset: number;
  pageSize: number;
  isPaged: boolean;
}

/** The multi-type search: one fixed window per type, never paged. */
export const STUDIO_SEARCH_FIRST_WINDOW: StudioSearchWindow = {
  offset: 0,
  pageSize: STUDIO_LIMITS.searchResultsPerType,
  isPaged: false,
};

/** A page of one search type, before the cursor is encoded. */
export interface StudioSearchSlice<Item> {
  items: Item[];
  hasMore: boolean;
}

export function studioSearchWindowAt(offset: number): StudioSearchWindow {
  return {
    offset,
    pageSize: STUDIO_LIMITS.searchResultsPerType,
    isPaged: true,
  };
}

/** Rows the query asks for: the page, plus one probe row when paged. */
export function studioSearchRowLimit(window: StudioSearchWindow): number {
  return window.pageSize + (window.isPaged ? 1 : 0);
}

/** Splits the probe row off. The caller maps the returned page rows. */
export function sliceStudioSearchRows<Row>(
  rows: Row[],
  window: StudioSearchWindow,
): { pageRows: Row[]; hasMore: boolean } {
  const hasMore = window.isPaged && rows.length > window.pageSize;
  return {
    pageRows: hasMore ? rows.slice(0, window.pageSize) : rows,
    hasMore,
  };
}

export function encodeStudioSearchCursor(offset: number): string {
  return Buffer.from(`${CURSOR_PREFIX}${offset}`, 'utf8').toString('base64url');
}

/** Never throws: a missing, malformed or too deep cursor reads as offset 0
 *  (the first page). */
export function decodeStudioSearchCursor(cursor: string | undefined): number {
  if (!cursor) {
    return 0;
  }
  const decoded = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!decoded.startsWith(CURSOR_PREFIX)) {
    return 0;
  }
  const offsetText = decoded.slice(CURSOR_PREFIX.length);
  if (!/^\d{1,6}$/.test(offsetText)) {
    return 0;
  }
  const offset = Number(offsetText);
  return offset <= STUDIO_SEARCH_MAX_OFFSET ? offset : 0;
}

/** The next page's cursor, or null on the last page and at the depth cap. */
export function nextStudioSearchCursor(
  window: StudioSearchWindow,
  hasMore: boolean,
): string | null {
  const nextOffset = window.offset + window.pageSize;
  return hasMore && nextOffset <= STUDIO_SEARCH_MAX_OFFSET
    ? encodeStudioSearchCursor(nextOffset)
    : null;
}
