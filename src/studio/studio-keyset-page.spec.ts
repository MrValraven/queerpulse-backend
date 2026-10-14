import { encodeStudioCursor } from './studio-cursor';
import { keysetCursorParameters, toKeysetPage } from './studio-keyset-page';

interface PositionRow {
  id: string;
  at: Date;
}

const positionRow = (index: number): PositionRow => ({
  id: `a9000000-0000-4000-8000-${String(100 + index).padStart(12, '0')}`,
  at: new Date(Date.UTC(2026, 9, 1, 0, 0, 59 - index)),
});

describe('Studio keyset pages', () => {
  it('binds a decoded cursor as two parameters and a missing or malformed one as nulls', () => {
    const at = new Date('2026-10-01T00:00:00.000Z');
    const id = 'a9000000-0000-4000-8000-000000000001';
    expect(
      keysetCursorParameters(encodeStudioCursor({ publishedAt: at, id })),
    ).toEqual([at, id]);
    expect(keysetCursorParameters(undefined)).toEqual([null, null]);
    expect(keysetCursorParameters('garbage')).toEqual([null, null]);
  });

  it('cuts the extra row, maps the page and points the cursor at the last page row', async () => {
    const rows = Array.from({ length: 4 }, (_unused, index) =>
      positionRow(index),
    );
    const page = await toKeysetPage(
      rows,
      3,
      (row) => ({ publishedAt: row.at, id: row.id }),
      (pageRows) => Promise.resolve(pageRows.map((row) => row.id)),
    );
    expect(page.items).toEqual([rows[0]!.id, rows[1]!.id, rows[2]!.id]);
    expect(page.pageInfo).toEqual({
      hasMore: true,
      nextCursor: encodeStudioCursor({
        publishedAt: rows[2]!.at,
        id: rows[2]!.id,
      }),
    });
  });

  it('answers no cursor on the last page, and keeps the cursor when the mapper drops a row', async () => {
    const lastPage = await toKeysetPage(
      [positionRow(0)],
      3,
      (row) => ({ publishedAt: row.at, id: row.id }),
      (pageRows) => Promise.resolve(pageRows),
    );
    expect(lastPage.pageInfo).toEqual({ hasMore: false, nextCursor: null });

    const rows = Array.from({ length: 3 }, (_unused, index) =>
      positionRow(index),
    );
    const thinnedPage = await toKeysetPage(
      rows,
      2,
      (row) => ({ publishedAt: row.at, id: row.id }),
      () => Promise.resolve([]),
    );
    expect(thinnedPage.items).toEqual([]);
    expect(thinnedPage.pageInfo.nextCursor).toBe(
      encodeStudioCursor({ publishedAt: rows[1]!.at, id: rows[1]!.id }),
    );
  });
});
