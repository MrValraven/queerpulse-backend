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
 * Sort direction for a keyset. Applies to BOTH the leading column and the `id`
 * tie-breaker, so the cursor tuple stays comparable with a single `<`/`>`.
 */
export type CursorDirection = 'ASC' | 'DESC';

/**
 * Describes an alternate keyset for `cursorPaginate` — a leading sort column
 * other than the default `(createdAt DESC, id DESC)` — so a caller can page a
 * list ordered by, e.g., `op_vote_count DESC` (forum `top`) or
 * `last_activity_at DESC` (forum `active`) while reusing the same seek
 * machinery. `id` remains the tie-breaker, in the same `direction`, keeping
 * the ordering total (never two rows the cursor can't separate).
 *
 * Only pass this for a NON-default sort; omit it and the function behaves
 * exactly as before (`createdAt` keyset, honoring
 * `createdAtColumnIsMillisecondPrecision`). When supplied, the leading column
 * is compared on the raw column (no `date_trunc` wrapper), so the backing
 * column must already be indexable and precision-matched to its cursor value
 * — `int`/`bigint` columns are exact by construction; a `timestamptz` column
 * used here must be written only from JS `Date`s (millisecond resolution) or
 * migrated to `timestamptz(3)`, per the same argument as
 * `createdAtColumnIsMillisecondPrecision` below.
 */
export interface CursorKeyset<E extends { id: string }> {
  /**
   * Alias-qualified raw SQL expression for the leading sort column, used
   * verbatim in ORDER BY and the WHERE tuple — e.g. `'"t"."op_vote_count"'`
   * or `'"t"."last_activity_at"'`.
   */
  columnExpr: string;
  /** Sort direction of the leading column (and the `id` tie-breaker). */
  direction: CursorDirection;
  /**
   * Value kind of the leading column — controls how the cursor value is
   * (de)serialized and typed for the WHERE parameter. `'number'` for
   * int/bigint counts, `'date'` for timestamp columns.
   */
  kind: 'number' | 'date';
  /** Reads the leading column's value off a row, for cursor encoding. */
  getValue: (row: E) => number | Date;
}

/** Serializes a keyset cursor value (`Date` → ISO, number → decimal string). */
function encodeKeysetCursor(value: number | Date, id: string): string {
  const serialized =
    value instanceof Date ? value.toISOString() : String(value);
  return Buffer.from(`${serialized}|${id}`).toString('base64');
}

/**
 * Decodes a keyset cursor produced by `encodeKeysetCursor`. Like
 * `decodeCursor`, never throws: any malformed input (or a value that doesn't
 * parse to the expected `kind`) resolves to `null` = "no cursor".
 */
function decodeKeysetCursor(
  cursor: string,
  kind: 'number' | 'date',
): { value: number | Date; id: string } | null {
  try {
    const decoded = Buffer.from(cursor, 'base64').toString('utf8');
    const separatorIndex = decoded.indexOf('|');
    if (separatorIndex === -1) return null;

    const serialized = decoded.slice(0, separatorIndex);
    const id = decoded.slice(separatorIndex + 1);
    if (!serialized || !id) return null;

    if (kind === 'number') {
      const value = Number(serialized);
      if (!Number.isFinite(value)) return null;
      return { value, id };
    }

    const value = new Date(serialized);
    if (Number.isNaN(value.getTime())) return null;
    return { value, id };
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
 *   every entity that hasn't been migrated yet. Ignored when `keyset` is
 *   supplied (an alternate keyset always compares on its raw column).
 * @param keyset Optional alternate sort keyset (see `CursorKeyset`). Omit for
 *   the default `createdAt` ordering; supply it to page by another column
 *   (forum `top`/`active`). Additive — existing callers pass nothing and are
 *   unaffected.
 */
export async function cursorPaginate<E extends { id: string; createdAt: Date }>(
  qb: SelectQueryBuilder<E>,
  cursor: string | undefined,
  limit: number,
  alias: string,
  createdAtColumnIsMillisecondPrecision = false,
  keyset?: CursorKeyset<E>,
): Promise<{ rows: E[]; nextCursor: string | null; hasMore: boolean }> {
  if (keyset) {
    // Alternate keyset: order by `(<leading column>, id)` in the keyset's
    // direction and, when a cursor decodes, seek strictly past the last row
    // the caller holds. `<`/`>` mirrors DESC/ASC so the same tuple predicate
    // works either way. The leading column is used raw (no `date_trunc`) — see
    // `CursorKeyset` for the precision contract that makes that safe.
    const comparator = keyset.direction === 'DESC' ? '<' : '>';
    qb.orderBy(keyset.columnExpr, keyset.direction).addOrderBy(
      `${alias}.id`,
      keyset.direction,
    );

    const decoded = cursor ? decodeKeysetCursor(cursor, keyset.kind) : null;
    if (decoded) {
      qb.andWhere(
        `(${keyset.columnExpr}, ${alias}.id) ${comparator} (:cursorValue, :cursorId)`,
        { cursorValue: decoded.value, cursorId: decoded.id },
      );
    }

    const rows = await qb.take(limit + 1).getMany();
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = page[page.length - 1];

    return {
      rows: page,
      nextCursor:
        hasMore && lastRow
          ? encodeKeysetCursor(keyset.getValue(lastRow), lastRow.id)
          : null,
      hasMore,
    };
  }

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
