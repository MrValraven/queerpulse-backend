import { ForumThread } from './entities/forum-thread.entity';

/**
 * The cursor for the forum's `top` sort (PRD-161).
 *
 * WHY THIS FILE EXISTS. `common/cursor-pagination.ts`'s `CursorKeyset` models
 * exactly one leading sort column plus the `id` tie-break, which is all every
 * other cursor-paginated list in the app needs. `top` needs three:
 * `op_vote_count DESC, last_activity_at DESC, id DESC`. Widening the shared
 * helper to an arbitrary column list would change the signature every
 * cursor-paginated endpoint in the app depends on, for one sort's benefit, so
 * the third column lives here instead, in the module that wants it. The seek
 * shape is otherwise identical to `cursorPaginate`'s alternate-keyset path, on
 * purpose: same base64 `value|value|id` envelope, same "a malformed cursor is
 * simply no cursor" rule, same row-constructor tuple comparison.
 *
 * WHY THREE COLUMNS. `top` used to order `op_vote_count DESC, id DESC` with no
 * second sort key, so every thread on zero votes (which on a young forum is
 * nearly all of them) came back ordered by a random uuid. The landing page was
 * a shuffled list that did not change as people posted, and a thread published
 * a minute ago sat below anything that had ever collected a single upvote.
 * `last_activity_at` in the middle makes the zero-vote tail fall back to
 * recency, which is what a reader expects to see there.
 *
 * WHY THE WINDOW FLAG RIDES IN THE CURSOR. `top` also narrows to threads
 * created in the last `TOP_WINDOW_DAYS`, so it means "top recently" rather than
 * "top ever", and falls back to the unwindowed set when too few threads match
 * (see `ForumThreadsService.paginateTop`). That decision must be made ONCE per
 * scroll session: re-deciding it per page would let page 2 answer a different
 * question than page 1, dropping or repeating whole blocks of threads as
 * threads are created underneath the reader. Carrying the answer in the cursor
 * means the count runs on the first page only and every later page inherits it.
 */
export interface TopThreadsCursor {
  /** Whether the page this cursor continues applied the recency window. */
  isWindowed: boolean;
  opVoteCount: number;
  lastActivityAt: Date;
  id: string;
}

// Field separator inside the decoded cursor. Safe against every value that goes
// in: an integer, an ISO-8601 timestamp and a uuid can none of them contain it.
const SEPARATOR = '|';

// Cursor prefix recording the window decision. Spelled as two letters rather
// than `true`/`false` so a hand-read cursor is unambiguous about which field it
// is looking at.
const WINDOWED = 'w';
const UNWINDOWED = 'a';

/**
 * Encodes the last row of a `top` page, plus the window decision that page was
 * computed under, into an opaque cursor.
 */
export function encodeTopThreadsCursor(
  row: ForumThread,
  isWindowed: boolean,
): string {
  const parts = [
    isWindowed ? WINDOWED : UNWINDOWED,
    String(row.opVoteCount),
    row.lastActivityAt.toISOString(),
    row.id,
  ];
  return Buffer.from(parts.join(SEPARATOR)).toString('base64');
}

/**
 * Decodes a cursor produced by `encodeTopThreadsCursor`. Never throws: any
 * malformed, truncated or client-forged input resolves to `null`, which the
 * caller treats as "no cursor" (first page) exactly as `decodeCursor` does,
 * rather than failing the request.
 */
export function decodeTopThreadsCursor(
  cursor: string,
): TopThreadsCursor | null {
  try {
    const parts = Buffer.from(cursor, 'base64')
      .toString('utf8')
      .split(SEPARATOR);
    if (parts.length !== 4) return null;
    const [windowFlag, rawVoteCount, rawLastActivityAt, id] = parts;
    if (windowFlag !== WINDOWED && windowFlag !== UNWINDOWED) return null;
    if (!rawVoteCount || !rawLastActivityAt || !id) return null;

    const opVoteCount = Number(rawVoteCount);
    if (!Number.isFinite(opVoteCount)) return null;

    const lastActivityAt = new Date(rawLastActivityAt);
    if (Number.isNaN(lastActivityAt.getTime())) return null;

    return {
      isWindowed: windowFlag === WINDOWED,
      opVoteCount,
      lastActivityAt,
      id,
    };
  } catch {
    return null;
  }
}
