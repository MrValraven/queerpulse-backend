/**
 * The "All" tab's cursor (SOC-04).
 *
 * THE PROBLEM. Keyset pagination works because the order is the sort key: the
 * last row you saw is a point you can seek past. Affinity ranking breaks that:
 * the last item on a ranked page is not the oldest one, so its
 * `(createdAt, id)` cannot say where the next page begins.
 *
 * THE FIX. Rank a WINDOW rather than a page. Each request pulls a fixed
 * chronological window (several pages' worth), ranks it, and serves one page
 * out of it. The cursor therefore carries the chronological boundary of the
 * window (a perfectly ordinary `encodeCursor` value, seeked on exactly as
 * every other tab does) and the offset already served within that window's
 * ranked order. When the offset runs off the end of the window, the next
 * cursor advances the window and resets the offset to zero.
 *
 * Ranking is a pure function of the window's rows and the viewer's graph, so
 * re-ranking the same window on the next request reproduces the same order:
 * no item is served twice and none is skipped.
 *
 * ANCHORING (ENG-134). "The same window" was only true if the window's rows
 * were the same rows. The FIRST window has no chronological boundary above it
 * (`windowCursor` is undefined), so page two re-materialised it from whatever
 * the top of the table was by then. Anything posted between the two requests
 * entered the window, shifted the ranked order under the served offset, and
 * the member saw a card twice (colliding on `key={item.id}` in the list) or
 * lost one silently. `anchorAt` fixes the window's ceiling on the first
 * request and every later page carries it back, so the window is a stable set
 * of rows for as long as the member keeps pressing "Load more".
 *
 * `lastKey` closes the other half of the same hole. The anchor stops rows
 * ENTERING the window; it cannot stop one LEAVING (a post deleted, a
 * community muted, an author blocked between two requests), which would
 * shuffle everything after it one slot up and make a plain offset skip a
 * card. Carrying the last item actually served lets the next request find its
 * position in the re-ranked window and continue from immediately after it,
 * falling back to the raw offset when that item is gone. One key rather than
 * every id already emitted: it is the same guarantee at a constant cursor
 * size, where the full id list would grow a URL by a window's worth of uuids.
 *
 * BACKWARD COMPATIBLE. A cursor that is not one of ours (an ordinary
 * `encodeCursor` value a client is still holding from before this shipped, or
 * a `rank1` cursor from before anchoring) decodes into the nearest honest
 * equivalent instead of being rejected.
 */

const RANKED_CURSOR_PREFIX = 'rank2';

/** The pre-anchoring format (`rank1|offset|windowCursor`). Still decoded, so
 *  a member holding one mid-scroll keeps their place rather than being thrown
 *  back to the top of their feed; it simply carries no anchor or last key, so
 *  the request it belongs to re-anchors itself. */
const LEGACY_RANKED_CURSOR_PREFIX = 'rank1';

export interface RankedCursor {
  /** The chronological cursor the window itself is fetched with. */
  windowCursor: string | undefined;
  /** How many items of this window's ranked order were already served. */
  offset: number;
  /**
   * The instant the window's ceiling was fixed at, on the request that built
   * the first page. Every source's candidate query bounds itself to
   * `createdAt <= anchorAt`, so re-materialising the window later returns the
   * same rows rather than the newest ones. Undefined on a first request and
   * on a legacy cursor, both of which stamp a fresh anchor.
   */
  anchorAt: Date | undefined;
  /**
   * `candidateKey` of the last candidate the PREVIOUS page served, before
   * block/mute filtering (the same pre-filter boundary the chronological tabs
   * anchor their cursor to). Undefined at the start of a window.
   */
  lastKey: string | undefined;
}

export const FIRST_RANKED_CURSOR: RankedCursor = {
  windowCursor: undefined,
  offset: 0,
  anchorAt: undefined,
  lastKey: undefined,
};

/**
 * `rank2|<offset>|<anchor millis>|<lastKey>|<windowCursor>`.
 *
 * `windowCursor` stays LAST because it is the only field that could ever grow
 * a separator of its own: it is base64, whose alphabet has no `|`, but
 * putting it at the tail means a future format change to it cannot corrupt
 * the fields in front (and `decodeRankedCursor` rejoins the tail rather than
 * taking one part). `lastKey` is `type:id`, neither half of which can contain
 * a `|`.
 */
export function encodeRankedCursor(
  windowCursor: string | undefined,
  offset: number,
  anchorAt: Date | undefined,
  lastKey: string | undefined,
): string {
  const anchorMillis = anchorAt ? String(anchorAt.getTime()) : '';
  return Buffer.from(
    `${RANKED_CURSOR_PREFIX}|${offset}|${anchorMillis}|${lastKey ?? ''}|${windowCursor ?? ''}`,
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

  if (parts[0] === LEGACY_RANKED_CURSOR_PREFIX) {
    // Pre-anchoring: `rank1|offset|windowCursor`. Honour the window and the
    // offset it carries and let the request stamp a fresh anchor.
    const legacyOffset = Number(parts[1]);
    if (!Number.isInteger(legacyOffset) || legacyOffset < 0) {
      return FIRST_RANKED_CURSOR;
    }
    const legacyWindowCursor = parts.slice(2).join('|');
    return {
      windowCursor: legacyWindowCursor || undefined,
      offset: legacyOffset,
      anchorAt: undefined,
      lastKey: undefined,
    };
  }

  if (parts[0] !== RANKED_CURSOR_PREFIX) {
    // A plain `(createdAt, id)` cursor from before ranking existed: treat it
    // as the start of a window rather than throwing the member back to the
    // top of their feed.
    return {
      windowCursor: cursor,
      offset: 0,
      anchorAt: undefined,
      lastKey: undefined,
    };
  }

  const offset = Number(parts[1]);
  if (!Number.isInteger(offset) || offset < 0) return FIRST_RANKED_CURSOR;

  // A forged or truncated anchor degrades to "no anchor" (the request stamps
  // a fresh one) rather than to an invalid Date that would compare false
  // against every row and empty the feed.
  const anchorMillis = Number(parts[2]);
  const anchorAt =
    parts[2] && Number.isFinite(anchorMillis) && anchorMillis > 0
      ? new Date(anchorMillis)
      : undefined;

  const lastKey = parts[3] || undefined;

  // The window cursor is itself base64 and so never contains a '|'; rejoining
  // is belt-and-braces against a future format change.
  const windowCursor = parts.slice(4).join('|');
  return { windowCursor: windowCursor || undefined, offset, anchorAt, lastKey };
}
