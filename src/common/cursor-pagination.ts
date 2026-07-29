import { SelectQueryBuilder } from 'typeorm';

/**
 * Envelope shared by every cursor-paginated list endpoint (feed, forum,
 * blocks, mutes, saved, drafts, ...). Distinct from the page-number
 * `Paginated<T>` in `./pagination.ts`, which existing directory-style lists
 * keep using.
 */
export interface CursorPage<T> {
  data: T[];
  pageInfo: {
    nextCursor: string | null;
    hasMore: boolean;
  };
}

/**
 * Encodes an opaque, keyset-pagination cursor from the `(createdAt, id)` of
 * the last row on a page. Order matters — `createdAt` first so the cursor
 * sorts the same way the keyset predicate does.
 */
export function encodeCursor(row: { createdAt: Date; id: string }): string {
  return Buffer.from(`${row.createdAt.toISOString()}|${row.id}`).toString(
    'base64',
  );
}

/**
 * Decodes a cursor produced by `encodeCursor`. Never throws: any malformed,
 * truncated, or otherwise undecodable input (including cursors forged by a
 * client) resolves to `null` so callers can treat it as "no cursor" rather
 * than fail the request.
 */
export function decodeCursor(
  cursor: string,
): { createdAt: Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf('|');
    if (separatorIndex === -1) return null;

    const iso = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    if (!iso || !id) return null;

    const createdAt = new Date(iso);
    if (Number.isNaN(createdAt.getTime())) return null;

    return { createdAt, id };
  } catch {
    return null;
  }
}

/**
 * Applies keyset (a.k.a. "seek") pagination to `qb`, ordering newest-first by
 * `(createdAt DESC, id DESC)`. When `cursor` decodes successfully, adds a
 * `(alias.createdAt, alias.id) < (:createdAt, :id)` predicate so the page
 * picks up strictly after the last row the caller already has.
 *
 * Fetches `limit + 1` rows to detect whether another page exists without a
 * separate count query; the extra row is trimmed off before returning.
 *
 * An invalid/malformed cursor is treated the same as no cursor (first page)
 * rather than rejecting the request — see `decodeCursor`.
 *
 * @param createdAtColumnIsMillisecondPrecision Set `true` only once the
 *   caller's entity has had its `created_at` column migrated to
 *   `timestamptz(3)` (millisecond precision, matching the cursor's own
 *   resolution — see `encodeCursor`). Defaults to `false`, which keeps the
 *   `date_trunc('milliseconds', …)` correctness wrapper described below for
 *   every entity that hasn't been migrated yet.
 */
export async function cursorPaginate<E extends { id: string; createdAt: Date }>(
  qb: SelectQueryBuilder<E>,
  cursor: string | undefined,
  limit: number,
  alias: string,
  createdAtColumnIsMillisecondPrecision = false,
): Promise<{ rows: E[]; nextCursor: string | null; hasMore: boolean }> {
  // CORRECTNESS NOTE (see connect-FINAL-review.md C1): a `created_at` column
  // declared plain `timestamptz` (no explicit precision) defaults to
  // microsecond precision in Postgres, but the cursor is built from a JS
  // `Date` (millisecond resolution) via `encodeCursor`/`toISOString()`. If
  // the WHERE predicate compared the millisecond cursor against the *raw*
  // (microsecond) column, a row sharing the cursor's millisecond but with
  // nonzero microseconds (e.g. `.123456` vs a cursor of `.123000`) would
  // compare `false` on the tuple `<` and be silently dropped from the next
  // page — never returned on either page. Truncating the column to
  // milliseconds with `date_trunc('milliseconds', …)` in BOTH the ORDER BY
  // and the WHERE tuple guarantees both sides of the comparison are at the
  // exact same resolution the cursor can represent, so no same-millisecond
  // row can fall through the gap.
  //
  // The trade-off: `date_trunc(text, timestamptz)` is STABLE, not IMMUTABLE
  // (it depends on the session's `TimeZone` setting), so Postgres refuses to
  // build a functional index on it — this ORDER BY/WHERE can never use an
  // index on `created_at`, no matter how the column itself is indexed, and
  // degrades to a full scan + in-memory sort as a table grows.
  //
  // `createdAtColumnIsMillisecondPrecision: true` is the real fix, not a
  // different workaround: once a migration narrows the column itself to
  // `timestamptz(3)`, the raw stored value IS already millisecond-precision
  // (Postgres rounds on write), so the cursor and the column agree by
  // construction and the `date_trunc` wrapper becomes unnecessary — ordering
  // and filtering can use the raw column directly, which a plain
  // `(created_at, id)` btree index can serve. `CommunityPost`, `ForumThread`,
  // and `Event` have been migrated this way (see
  // `1785001400000-NarrowCursorCreatedAtPrecision.ts`); any other entity
  // routed through this function keeps the `date_trunc` wrapper by default
  // until it's migrated too.
  const createdAtExpr = createdAtColumnIsMillisecondPrecision
    ? `"${alias}"."created_at"`
    : `date_trunc('milliseconds', "${alias}"."created_at")`;

  qb.orderBy(createdAtExpr, 'DESC').addOrderBy(`${alias}.id`, 'DESC');

  const decoded = cursor ? decodeCursor(cursor) : null;
  if (decoded) {
    qb.andWhere(
      `(${createdAtExpr}, ${alias}.id) < (:cursorCreatedAt, :cursorId)`,
      {
        cursorCreatedAt: decoded.createdAt,
        cursorId: decoded.id,
      },
    );
  }

  const rows = await qb.take(limit + 1).getMany();
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const lastRow = page[page.length - 1];

  return {
    rows: page,
    nextCursor: hasMore && lastRow ? encodeCursor(lastRow) : null,
    hasMore,
  };
}
