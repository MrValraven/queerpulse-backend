/**
 * The "All" tab's cursor (SOC-04).
 *
 * THE PROBLEM. Keyset pagination works because the order is the sort key: the
 * last row you saw is a point you can seek past. Affinity ranking breaks that
 * — the last item on a ranked page is not the oldest one, so its
 * `(createdAt, id)` cannot say where the next page begins.
 *
 * THE FIX. Rank a WINDOW rather than a page. Each request pulls a fixed
 * chronological window (several pages' worth), ranks it, and serves one page
 * out of it. The cursor therefore carries two things: the chronological
 * boundary of the window (a perfectly ordinary `encodeCursor` value, seeked
 * on exactly as every other tab does) and the offset already served within
 * that window's ranked order. When the offset runs off the end of the window,
 * the next cursor advances the window and resets the offset to zero.
 *
 * Ranking is a pure function of the window's rows and the viewer's graph, so
 * re-ranking the same window on the next request reproduces the same order:
 * no item is served twice and none is skipped.
 *
 * BACKWARD COMPATIBLE. A cursor that is not one of ours (an ordinary
 * `encodeCursor` value a client is still holding from before this shipped)
 * decodes as "that window, offset 0" instead of being rejected.
 */

const RANKED_CURSOR_PREFIX = 'rank1';

export interface RankedCursor {
  /** The chronological cursor the window itself is fetched with. */
  windowCursor: string | undefined;
  /** How many items of this window's ranked order were already served. */
  offset: number;
}

export const FIRST_RANKED_CURSOR: RankedCursor = {
  windowCursor: undefined,
  offset: 0,
};

export function encodeRankedCursor(
  windowCursor: string | undefined,
  offset: number,
): string {
  return Buffer.from(
    `${RANKED_CURSOR_PREFIX}|${offset}|${windowCursor ?? ''}`,
  ).toString('base64');
}

/**
 * Never throws and never rejects: anything undecodable (including a cursor
 * forged by a client) resolves to the first page, matching `decodeCursor`'s
 * contract in `common/cursor-pagination.ts`.
 */
export function decodeRankedCursor(cursor: string | undefined): RankedCursor {
  if (!cursor) return FIRST_RANKED_CURSOR;
  let decoded: string;
  try {
    decoded = Buffer.from(cursor, 'base64').toString('utf8');
  } catch {
    return FIRST_RANKED_CURSOR;
  }

  const parts = decoded.split('|');
  if (parts[0] !== RANKED_CURSOR_PREFIX) {
    // A plain `(createdAt, id)` cursor from before ranking existed: treat it
    // as the start of a window rather than throwing the member back to the
    // top of their feed.
    return { windowCursor: cursor, offset: 0 };
  }

  const offset = Number(parts[1]);
  if (!Number.isInteger(offset) || offset < 0) return FIRST_RANKED_CURSOR;

  // The window cursor is itself base64 and so never contains a '|'; rejoining
  // is belt-and-braces against a future format change.
  const windowCursor = parts.slice(2).join('|');
  return { windowCursor: windowCursor || undefined, offset };
}
