import { SelectQueryBuilder } from 'typeorm';
import {
  cursorPaginate,
  decodeCursor,
  encodeCursor,
} from './cursor-pagination';

interface Row {
  id: string;
  createdAt: Date;
}

function row(id: string, iso: string): Row {
  return { id, createdAt: new Date(iso) };
}

// Minimal chainable stub mirroring the subset of SelectQueryBuilder that
// cursorPaginate touches: orderBy/addOrderBy/andWhere/take return `this`,
// getMany resolves to a pre-seeded result set. Kept as a plain
// `Record<string, jest.Mock>` (not cast to the real interface) so assertions
// like `expect(qb.orderBy)` don't trip `@typescript-eslint/unbound-method`
// (mirrors `community-posts.service.spec.ts`'s `qbStub`).
function qbStub(rows: Row[]): Record<string, jest.Mock> {
  const qb: Record<string, jest.Mock> = {
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(rows),
  };
  return qb;
}

function asQb(qb: Record<string, jest.Mock>): SelectQueryBuilder<Row> {
  return qb as unknown as SelectQueryBuilder<Row>;
}

describe('encodeCursor / decodeCursor', () => {
  it('round-trips createdAt + id through base64', () => {
    const r = row('abc-123', '2026-07-15T12:34:56.789Z');
    const cursor = encodeCursor(r);
    const decoded = decodeCursor(cursor);
    expect(decoded).not.toBeNull();
    expect(decoded?.id).toBe('abc-123');
    expect(decoded?.createdAt.toISOString()).toBe('2026-07-15T12:34:56.789Z');
  });

  it('encodes as base64 of `${iso}|${id}`', () => {
    const r = row('id-1', '2026-01-01T00:00:00.000Z');
    const cursor = encodeCursor(r);
    expect(Buffer.from(cursor, 'base64').toString('utf8')).toBe(
      '2026-01-01T00:00:00.000Z|id-1',
    );
  });

  it('returns null for garbage input', () => {
    expect(decodeCursor('not-valid-base64-!!!')).toBeNull();
  });

  it('returns null when there is no separator', () => {
    const cursor = Buffer.from('no-separator-here').toString('base64');
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null when the date segment is unparseable', () => {
    const cursor = Buffer.from('not-a-date|some-id').toString('base64');
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('returns null when the id segment is empty', () => {
    const cursor = Buffer.from('2026-01-01T00:00:00.000Z|').toString('base64');
    expect(decodeCursor(cursor)).toBeNull();
  });

  it('never throws on empty input', () => {
    expect(() => decodeCursor('')).not.toThrow();
    expect(decodeCursor('')).toBeNull();
  });
});

describe('cursorPaginate', () => {
  it('orders by createdAt DESC, id DESC and does not add a WHERE without a cursor', async () => {
    const rows = [row('1', '2026-07-15T00:00:03.000Z')];
    const qb = qbStub(rows);

    const result = await cursorPaginate(asQb(qb), undefined, 20, 'e');

    expect(qb.orderBy).toHaveBeenCalledWith(
      `date_trunc('milliseconds', "e"."created_at")`,
      'DESC',
    );
    expect(qb.addOrderBy).toHaveBeenCalledWith('e.id', 'DESC');
    expect(qb.andWhere).not.toHaveBeenCalled();
    expect(qb.take).toHaveBeenCalledWith(21); // limit + 1
    expect(result.rows).toEqual(rows);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('adds the keyset predicate when a valid cursor is provided', async () => {
    const qb = qbStub([]);
    const cursor = encodeCursor(row('9', '2026-07-14T00:00:00.000Z'));

    await cursorPaginate(asQb(qb), cursor, 20, 'e');

    expect(qb.andWhere).toHaveBeenCalledWith(
      `(date_trunc('milliseconds', "e"."created_at"), e.id) < (:cursorCreatedAt, :cursorId)`,
      { cursorCreatedAt: new Date('2026-07-14T00:00:00.000Z'), cursorId: '9' },
    );
  });

  it("(C1 regression) truncates the ORDER BY/WHERE column to milliseconds so a row sharing the cursor's millisecond with different microseconds is not skipped across a page boundary", async () => {
    // Postgres stores `created_at` as microsecond-precision timestamptz, but
    // the cursor only carries millisecond resolution (JS `Date`). Before this
    // fix, the WHERE predicate compared the truncated cursor against the raw
    // (microsecond) column: a row at `.123456` compared against a cursor
    // truncated to `.123000` evaluates `.123456 < .123000` -> false, dropping
    // it from the next page even though it was never returned on the
    // previous one. Truncating the column with the same `date_trunc` used in
    // ORDER BY puts both sides of the comparison at identical resolution, so
    // this can no longer happen.
    const qb = qbStub([]);
    const cursor = encodeCursor(
      row('boundary-row', '2026-07-15T12:00:00.123Z'),
    );

    await cursorPaginate(asQb(qb), cursor, 20, 'e');

    const truncatedExpr = `date_trunc('milliseconds', "e"."created_at")`;
    expect(qb.orderBy).toHaveBeenCalledWith(truncatedExpr, 'DESC');
    expect(qb.andWhere).toHaveBeenCalledWith(
      `(${truncatedExpr}, e.id) < (:cursorCreatedAt, :cursorId)`,
      {
        cursorCreatedAt: new Date('2026-07-15T12:00:00.123Z'),
        cursorId: 'boundary-row',
      },
    );
    // Both the ORDER BY key and the WHERE tuple's first element are the
    // *same* truncated expression as the parameter's resolution (ms) — a row
    // stored as `2026-07-15T12:00:00.1234567` truncates to the same
    // `.123` value used here, so `(truncated, id) < (cursor, id)` correctly
    // falls back to the `id` tie-break instead of spuriously excluding it.
  });

  it('ignores a malformed cursor (treats it as the first page) instead of throwing', async () => {
    const qb = qbStub([]);

    await expect(
      cursorPaginate(asQb(qb), 'garbage-cursor', 20, 'e'),
    ).resolves.toBeDefined();
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('hasMore is false and nextCursor is null when exactly `limit` rows come back', async () => {
    const rows = [
      row('3', '2026-07-15T00:00:03.000Z'),
      row('2', '2026-07-15T00:00:02.000Z'),
    ];
    const qb = qbStub(rows);

    const result = await cursorPaginate(asQb(qb), undefined, 2, 'e');

    expect(result.rows).toHaveLength(2);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });

  it('hasMore is true and nextCursor points at the last *returned* row when limit+1 rows come back', async () => {
    const rows = [
      row('3', '2026-07-15T00:00:03.000Z'),
      row('2', '2026-07-15T00:00:02.000Z'),
      row('1', '2026-07-15T00:00:01.000Z'), // the +1 lookahead row
    ];
    const qb = qbStub(rows);

    const result = await cursorPaginate(asQb(qb), undefined, 2, 'e');

    expect(result.rows).toEqual(rows.slice(0, 2));
    expect(result.hasMore).toBe(true);
    expect(result.nextCursor).toBe(encodeCursor(rows[1]));
  });

  it('nextCursor decodes back to the last returned row id/createdAt', async () => {
    const rows = [
      row('3', '2026-07-15T00:00:03.000Z'),
      row('2', '2026-07-15T00:00:02.000Z'),
      row('1', '2026-07-15T00:00:01.000Z'),
    ];
    const qb = qbStub(rows);

    const result = await cursorPaginate(asQb(qb), undefined, 2, 'e');
    const decoded = decodeCursor(result.nextCursor as string);

    expect(decoded?.id).toBe('2');
    expect(decoded?.createdAt.toISOString()).toBe('2026-07-15T00:00:02.000Z');
  });
});
