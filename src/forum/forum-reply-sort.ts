import { SelectQueryBuilder } from 'typeorm';
import { CursorKeyset } from '../common/cursor-pagination';
import { ForumPost } from './entities/forum-post.entity';

/**
 * The three orderings `GET /forum/threads/:slug/posts` serves (C6/PRD-162).
 *
 * WHY THIS EXISTS AT ALL. The reply sort bar used to be entirely client-side:
 * "Newest" reversed the replies that happened to be loaded and "Most helpful"
 * ranked them on a demo-only `helpful` flag with a like-count fallback. Replies
 * arrive oldest-first in pages of twenty, so on a sixty-reply thread "Newest"
 * showed the twenty OLDEST replies, reversed, labelled as the newest, and a
 * member trying to catch up had to press "Load more" twice before the replies
 * they were asking for existed on the page at all. A sort that only sorts the
 * current page is not a sort; it has to be the server's ORDER BY.
 */
export type ReplySort = 'oldest' | 'newest' | 'top';

/** Accepted `?sort=` values, in the order the DTO validates them. */
export const REPLY_SORTS: readonly ReplySort[] = ['oldest', 'newest', 'top'];

/**
 * The default, and the behaviour every existing caller gets by omitting
 * `?sort=`: chronological, the OP's own conversation read top to bottom.
 */
export const DEFAULT_REPLY_SORT: ReplySort = 'oldest';

/**
 * `oldest` and `newest` are one column plus the `id` tie-break in the same
 * direction, which is exactly what the shared `CursorKeyset` models, so they
 * ride `cursorPaginate`'s alternate-keyset path unchanged.
 *
 * `ForumPost.createdAt` is `timestamptz(3)` (see
 * `1787600000000-NarrowForumPostCreatedAtPrecision.ts`), matching the
 * millisecond resolution of the `Date` the cursor is built from, so the raw
 * column can be compared directly with no `date_trunc(...)` wrapper. Both
 * directions therefore ride `IDX_forum_post_thread_id_created_at_id` (forwards
 * for `oldest`, as a backward scan for `newest`) instead of forcing a sort.
 *
 * Returns undefined for `top`, which needs three columns in two directions and
 * cannot be expressed as a `CursorKeyset` at all — see `applyTopReplySeek`.
 */
export function keysetForReplySort(
  sort: ReplySort,
): CursorKeyset<ForumPost> | undefined {
  if (sort === 'top') return undefined;
  return {
    columnExpr: '"p"."created_at"',
    direction: sort === 'newest' ? 'DESC' : 'ASC',
    kind: 'date',
    getValue: (row) => row.createdAt,
  };
}

/**
 * The `top` cursor: `vote_count DESC, created_at ASC, id ASC` (C6).
 *
 * WHY IT IS NOT A `CursorKeyset`. That helper compares a `(column, id)` tuple
 * with a single `<` or `>`, which a Postgres row constructor only answers
 * correctly when every member sorts the same way. `top` sorts votes DESCENDING
 * and then falls back to the OLDEST reply, so the two halves disagree and the
 * seek has to be spelled out (see `applyTopReplySeek`).
 *
 * WHY THE TIE-BREAK IS OLDEST-FIRST. Almost every reply on a young thread has
 * zero votes, so the tie-break is the ordering nearly all the time. Oldest-first
 * there means an unvoted "Most helpful" page reads as the conversation in order
 * rather than as a shuffle, and an answer that has been sitting there unvoted
 * outranks one posted a minute ago rather than the other way round.
 */
export interface TopRepliesCursor {
  voteCount: number;
  createdAt: Date;
  id: string;
}

// Field separator inside the decoded cursor, mirroring `forum-top-keyset.ts`.
// Safe against every value that goes in: an integer, an ISO-8601 timestamp and
// a uuid can none of them contain it.
const SEPARATOR = '|';

/** Encodes the last row of a `top` page into an opaque cursor. */
export function encodeTopRepliesCursor(row: ForumPost): string {
  const parts = [String(row.voteCount), row.createdAt.toISOString(), row.id];
  return Buffer.from(parts.join(SEPARATOR)).toString('base64');
}

/**
 * Decodes a cursor produced by `encodeTopRepliesCursor`. Never throws: any
 * malformed, truncated or client-forged input resolves to `null`, which the
 * caller treats as "no cursor" (first page), exactly as `decodeCursor` does.
 */
export function decodeTopRepliesCursor(
  cursor: string,
): TopRepliesCursor | null {
  try {
    const parts = Buffer.from(cursor, 'base64')
      .toString('utf8')
      .split(SEPARATOR);
    if (parts.length !== 3) return null;
    const [rawVoteCount, rawCreatedAt, id] = parts;
    if (!rawVoteCount || !rawCreatedAt || !id) return null;

    const voteCount = Number(rawVoteCount);
    if (!Number.isFinite(voteCount)) return null;

    const createdAt = new Date(rawCreatedAt);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { voteCount, createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Orders a reply query by `top` and, when a cursor decodes, seeks strictly past
 * the last row the caller already holds.
 *
 * The predicate is written out rather than as a row constructor because the
 * columns disagree on direction (see `TopRepliesCursor`): rows below the
 * cursor's vote count qualify outright, and rows ON it qualify only when their
 * `(created_at, id)` sorts after the cursor's. Together those two branches are
 * exactly the rows the ORDER BY places after the cursor row, and nothing else.
 *
 * `IDX_forum_post_thread_id_vote_count_created_at_id` (see
 * `AddForumPostTopKeyset`) matches this ORDER BY column for
 * column and direction for direction, so the seek is an index range scan rather
 * than a sort of the whole thread.
 */
export function applyTopReplySeek(
  queryBuilder: SelectQueryBuilder<ForumPost>,
  cursor: string | undefined,
): void {
  queryBuilder
    .orderBy('"p"."vote_count"', 'DESC')
    .addOrderBy('"p"."created_at"', 'ASC')
    .addOrderBy('"p"."id"', 'ASC');

  const decoded = cursor ? decodeTopRepliesCursor(cursor) : null;
  if (!decoded) return;

  queryBuilder.andWhere(
    `(
      "p"."vote_count" < :topCursorVoteCount
      OR (
        "p"."vote_count" = :topCursorVoteCount
        AND ("p"."created_at", "p"."id") > (:topCursorCreatedAt, :topCursorId)
      )
    )`,
    {
      topCursorVoteCount: decoded.voteCount,
      topCursorCreatedAt: decoded.createdAt,
      topCursorId: decoded.id,
    },
  );
}

/**
 * The same ORDER BY as the paginated root stream, for the descendant rows a
 * page carries alongside its roots.
 *
 * Descendants are not paginated (a root always ships with its whole subtree, so
 * a reply never arrives before its parent), so they need no seek — only the
 * ordering, so that siblings under one parent read in the order the member
 * asked for, at every depth and not just at the top level.
 */
export function applyReplyOrder(
  queryBuilder: SelectQueryBuilder<ForumPost>,
  sort: ReplySort,
): void {
  if (sort === 'top') {
    queryBuilder
      .orderBy('"p"."vote_count"', 'DESC')
      .addOrderBy('"p"."created_at"', 'ASC')
      .addOrderBy('"p"."id"', 'ASC');
    return;
  }
  const direction = sort === 'newest' ? 'DESC' : 'ASC';
  queryBuilder
    .orderBy('"p"."created_at"', direction)
    .addOrderBy('"p"."id"', direction);
}
