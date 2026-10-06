import type { ObjectLiteral, SelectQueryBuilder } from 'typeorm';
import {
  applyPlatformLogWindow,
  compactParams,
  exactTimeSql,
  selectPlatformLogColumns,
  sinceForRange,
} from './platform-log-query';
import type { SourceWindow } from './platform-log.types';

type QueryBuilderMethod =
  'select' | 'addSelect' | 'andWhere' | 'orderBy' | 'addOrderBy' | 'limit';
type QueryBuilderStub = Record<QueryBuilderMethod, jest.Mock>;

function queryBuilderStub(): QueryBuilderStub {
  const methods: QueryBuilderMethod[] = [
    'select',
    'addSelect',
    'andWhere',
    'orderBy',
    'addOrderBy',
    'limit',
  ];
  const queryBuilder = {} as QueryBuilderStub;
  for (const method of methods) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

function asQueryBuilder(stub: QueryBuilderStub) {
  return stub as unknown as SelectQueryBuilder<ObjectLiteral>;
}

function windowWith(overrides: Partial<SourceWindow> = {}): SourceWindow {
  return {
    cursor: null,
    since: null,
    limit: 30,
    memberId: null,
    staffRowsOnly: false,
    categories: ['moderation'],
    ...overrides,
  };
}

const COLUMNS = { timeSql: '"e"."created_at"', idSql: '"e"."id"' };
const CURSOR = {
  occurredAtExact: '2026-10-05T12:00:00.123456Z',
  sourceKey: 'mod',
  rowId: 'row-9',
};

describe('platform log query helpers', () => {
  it('formats the exact time as a fixed microsecond UTC string', () => {
    expect(exactTimeSql('"e"."created_at"')).toBe(
      `to_char("e"."created_at" AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    );
  });

  it('selects the first column and adds the rest', () => {
    const stub = queryBuilderStub();
    selectPlatformLogColumns(asQueryBuilder(stub), {
      row_id: '"e"."id"',
      note: '"e"."note"',
    });
    expect(stub.select).toHaveBeenCalledWith('"e"."id"', 'row_id');
    expect(stub.addSelect).toHaveBeenCalledWith('"e"."note"', 'note');
  });

  it('orders newest first and fetches one extra row', () => {
    const stub = queryBuilderStub();
    applyPlatformLogWindow(asQueryBuilder(stub), 'mod', COLUMNS, windowWith());
    expect(stub.orderBy).toHaveBeenCalledWith('"e"."created_at"', 'DESC');
    expect(stub.addOrderBy).toHaveBeenCalledWith(
      'CAST("e"."id" AS text) COLLATE "C"',
      'DESC',
    );
    expect(stub.limit).toHaveBeenCalledWith(31);
    expect(stub.andWhere).not.toHaveBeenCalled();
  });

  it('includes the cursor time for a source that sorts below the cursor source', () => {
    const stub = queryBuilderStub();
    applyPlatformLogWindow(
      asQueryBuilder(stub),
      'gov',
      COLUMNS,
      windowWith({ cursor: CURSOR }),
    );
    expect(stub.andWhere).toHaveBeenCalledWith(
      '"e"."created_at" <= CAST(:platformLogCursorTime AS timestamptz)',
      {
        platformLogCursorTime: CURSOR.occurredAtExact,
        platformLogCursorRowId: 'row-9',
      },
    );
  });

  it('excludes the cursor time for a source that sorts above the cursor source', () => {
    const stub = queryBuilderStub();
    applyPlatformLogWindow(
      asQueryBuilder(stub),
      'vouch',
      COLUMNS,
      windowWith({ cursor: CURSOR }),
    );
    expect(stub.andWhere.mock.calls[0]?.[0]).toBe(
      '"e"."created_at" < CAST(:platformLogCursorTime AS timestamptz)',
    );
  });

  it('breaks ties by row id inside the cursor source', () => {
    const stub = queryBuilderStub();
    applyPlatformLogWindow(
      asQueryBuilder(stub),
      'mod',
      COLUMNS,
      windowWith({ cursor: CURSOR }),
    );
    expect(stub.andWhere.mock.calls[0]?.[0]).toBe(
      '("e"."created_at" < CAST(:platformLogCursorTime AS timestamptz) OR ' +
        '("e"."created_at" = CAST(:platformLogCursorTime AS timestamptz) AND ' +
        'CAST("e"."id" AS text) COLLATE "C" < :platformLogCursorRowId))',
    );
  });

  it('adds the lower time bound for a range', () => {
    const stub = queryBuilderStub();
    const since = new Date('2026-10-01T00:00:00Z');
    applyPlatformLogWindow(
      asQueryBuilder(stub),
      'mod',
      COLUMNS,
      windowWith({ since }),
    );
    expect(stub.andWhere).toHaveBeenCalledWith(
      '"e"."created_at" >= :platformLogSince',
      { platformLogSince: since },
    );
  });

  it('maps ranges to lower bounds', () => {
    const now = new Date('2026-10-05T15:30:00Z');
    expect(sinceForRange('all', now)).toBeNull();
    expect(sinceForRange('today', now)?.toISOString()).toBe(
      '2026-10-05T00:00:00.000Z',
    );
    expect(sinceForRange('week', now)?.toISOString()).toBe(
      '2026-09-28T15:30:00.000Z',
    );
    expect(sinceForRange('month', now)?.toISOString()).toBe(
      '2026-09-05T15:30:00.000Z',
    );
    expect(sinceForRange('quarter', now)?.toISOString()).toBe(
      '2026-07-07T15:30:00.000Z',
    );
  });

  it('drops empty params', () => {
    expect(
      compactParams({
        field: 'mrr',
        oldValue: null,
        newValue: '',
        note: undefined,
      }),
    ).toEqual({
      field: 'mrr',
    });
  });
});
