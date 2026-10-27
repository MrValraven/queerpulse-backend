import { ADMIN_SCENE_RELEASES_SQL } from './admin-studio-scenes.service';
import { APPEARS_ON_SQL } from './studio-appears-on.service';
import { decodeStudioCursor } from './studio-cursor';
import { toKeysetPage } from './studio-keyset-page';

/*
 * A persona unlink gives every release of the persona a fresh random id and
 * one shared `published_at` / `created_at` (`now()`), so a whole persona's
 * releases tie on the sort time and the fresh id is the only thing that
 * orders them. A page boundary can fall inside that tie. These specs pin that
 * every keyset read orders and compares on `(time, id)` and that a cursor cut
 * inside a tie neither skips nor repeats a release.
 */

interface ReleaseRow {
  id: string;
  publishedAt: Date;
}

const UNLINK_TIME = new Date('2026-10-20T12:00:00.123Z');

/** Fresh ids as `gen_random_uuid()` leaves them: no relation to old order. */
const FRESH_IDS = [
  '9f1c0000-0000-4000-8000-000000000007',
  '0a2d0000-0000-4000-8000-000000000003',
  'c4e10000-0000-4000-8000-000000000001',
  '3b770000-0000-4000-8000-000000000009',
  'e5a80000-0000-4000-8000-000000000005',
  '71230000-0000-4000-8000-000000000002',
  'b0660000-0000-4000-8000-000000000008',
];

const tiedRows: ReleaseRow[] = FRESH_IDS.map((id) => ({
  id,
  publishedAt: UNLINK_TIME,
}));

const olderRow: ReleaseRow = {
  id: 'd0000000-0000-4000-8000-000000000001',
  publishedAt: new Date('2026-10-01T09:00:00.000Z'),
};

/** What Postgres does for `ORDER BY t DESC, id DESC` and the row-wise
 *  `(t, id) < (cursorT, cursorId)` filter. */
function readPage(
  allRows: ReleaseRow[],
  cursor: string | undefined,
  pageSize: number,
): ReleaseRow[] {
  const decodedCursor = decodeStudioCursor(cursor);
  return [...allRows]
    .sort((left, right) =>
      left.publishedAt.getTime() !== right.publishedAt.getTime()
        ? right.publishedAt.getTime() - left.publishedAt.getTime()
        : right.id.localeCompare(left.id),
    )
    .filter((row) => {
      if (!decodedCursor) return true;
      const rowTime = row.publishedAt.getTime();
      const cursorTime = decodedCursor.publishedAt.getTime();
      return (
        rowTime < cursorTime ||
        (rowTime === cursorTime && row.id < decodedCursor.id)
      );
    })
    .slice(0, pageSize + 1);
}

async function walk(
  allRows: ReleaseRow[],
  pageSize: number,
): Promise<string[]> {
  const seenIds: string[] = [];
  let cursor: string | undefined;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = await toKeysetPage(
      readPage(allRows, cursor, pageSize),
      pageSize,
      (row) => ({ publishedAt: row.publishedAt, id: row.id }),
      (pageRows) => Promise.resolve(pageRows.map((row) => row.id)),
    );
    seenIds.push(...page.items);
    if (!page.pageInfo.nextCursor) break;
    cursor = page.pageInfo.nextCursor;
  }
  return seenIds;
}

describe('keyset paging across a persona unlink', () => {
  it.each([1, 2, 3, 4, 7])(
    'lists every release once when pages of %s cut inside the tied unlink time',
    async (pageSize) => {
      const seenIds = await walk([...tiedRows, olderRow], pageSize);
      expect(seenIds).toHaveLength(tiedRows.length + 1);
      expect(new Set(seenIds).size).toBe(seenIds.length);
      expect([...seenIds].sort()).toEqual([...FRESH_IDS, olderRow.id].sort());
    },
  );

  it('keeps the tied releases in descending id order with the older one last', async () => {
    const seenIds = await walk([...tiedRows, olderRow], 3);
    expect(seenIds.slice(0, tiedRows.length)).toEqual(
      [...FRESH_IDS].sort().reverse(),
    );
    expect(seenIds[seenIds.length - 1]).toBe(olderRow.id);
  });

  it.each([
    ['the Appears on read', APPEARS_ON_SQL, '"release"."published_at"'],
    [
      'the staff scene releases read',
      ADMIN_SCENE_RELEASES_SQL,
      `date_trunc('milliseconds', "release"."created_at")`,
    ],
  ])(
    'compares %s on (time, id) and orders by both, newest first',
    (_label, sql, timeExpression) => {
      expect(sql).toContain(`(${timeExpression}, "release"."id") <`);
      expect(sql).toContain(
        `ORDER BY ${timeExpression} DESC, "release"."id" DESC`,
      );
    },
  );

  it('truncates a microsecond created_at to the cursor millisecond on both sides', () => {
    // A JS Date cursor holds milliseconds; an untruncated microsecond column
    // would sort a tied row above the cursor and drop it from the next page.
    expect(ADMIN_SCENE_RELEASES_SQL).not.toMatch(
      /"release"\."created_at"(?!\))/,
    );
  });
});
