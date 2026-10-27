import { NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { ForumPost } from '../forum/entities/forum-post.entity';
import { ForumThread } from '../forum/entities/forum-thread.entity';
import { AdminFeatureUsageDetailService } from './admin-feature-usage-detail.service';
import { AdminFeatureUsageService } from './admin-feature-usage.service';
import { resolveUsageRange, UsageRange } from './feature-usage-range';

const NOW = new Date('2026-10-26T15:00:00Z');

interface CreatedDayRow {
  day: string;
  total: string;
}

const CHAINABLE_METHODS = [
  'select',
  'addSelect',
  'where',
  'andWhere',
  'groupBy',
  'addGroupBy',
] as const;

type ChainableMethod = (typeof CHAINABLE_METHODS)[number];

type QueryBuilderStub = Record<ChainableMethod, jest.Mock> & {
  getRawMany: jest.Mock;
  getCount: jest.Mock;
};

interface RecordedQuery {
  entity: unknown;
  queryBuilder: QueryBuilderStub;
}

/** Per-day rows each forum entity returns from the grouped detail query,
 *  inside the worked-example window 2026-09-26 to 2026-10-25. */
const FORUM_CREATED_ROWS = new Map<unknown, CreatedDayRow[]>([
  [
    ForumThread,
    [
      { day: '2026-09-26', total: '2' },
      { day: '2026-10-10', total: '1' },
      { day: '2026-10-25', total: '4' },
    ],
  ],
  [
    ForumPost,
    [
      { day: '2026-09-26', total: '3' },
      { day: '2026-10-11', total: '6' },
    ],
  ],
]);

function totalCreatedFor(entity: unknown): number {
  return (FORUM_CREATED_ROWS.get(entity) ?? []).reduce(
    (total, row) => total + Number(row.total),
    0,
  );
}

/** A chainable query-builder stub. `getRawMany` returns the entity's grouped
 *  rows; `getCount` returns the entity's in-range total only when the
 *  `>= :rangeStart` predicate was applied, so a depth query and a grouped
 *  detail query over the same fixture agree by construction of the stub and
 *  disagree the moment either side changes its predicates. */
function queryBuilderStub(entity: unknown): QueryBuilderStub {
  const queryBuilder = {} as QueryBuilderStub;
  for (const method of CHAINABLE_METHODS) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getRawMany = jest
    .fn()
    .mockResolvedValue(FORUM_CREATED_ROWS.get(entity) ?? []);
  queryBuilder.getCount = jest.fn(() => {
    const isInRangeCount = queryBuilder.where.mock.calls.some(
      ([condition]) => condition === 'row.createdAt >= :rangeStart',
    );
    return Promise.resolve(isInRangeCount ? totalCreatedFor(entity) : 0);
  });
  return queryBuilder;
}

function buildDataSource() {
  const recordedQueries: RecordedQuery[] = [];
  const dataSource = {
    createQueryBuilder: jest.fn((entity: unknown) => {
      const queryBuilder = queryBuilderStub(entity);
      recordedQueries.push({ entity, queryBuilder });
      return queryBuilder;
    }),
    getRepository: jest.fn(() => ({ count: jest.fn().mockResolvedValue(0) })),
  };
  return { dataSource, recordedQueries };
}

function presetRange(rangeDays: number): UsageRange {
  return resolveUsageRange({ rangeDays: String(rangeDays) }, NOW, 730);
}

function sumValues(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function predicatesOf(queryBuilder: QueryBuilderStub): unknown[][] {
  const whereCalls = queryBuilder.where.mock.calls as unknown[][];
  const andWhereCalls = queryBuilder.andWhere.mock.calls as unknown[][];
  return [...whereCalls, ...andWhereCalls];
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  return undefined;
}

describe('AdminFeatureUsageDetailService', () => {
  let service: AdminFeatureUsageDetailService;
  let dataSource: ReturnType<typeof buildDataSource>['dataSource'];
  let recordedQueries: RecordedQuery[];

  beforeEach(() => {
    ({ dataSource, recordedQueries } = buildDataSource());
    service = new AdminFeatureUsageDetailService(
      dataSource as unknown as DataSource,
    );
  });

  describe('getDetail: rejected keys', () => {
    it('answers an unregistered key with feature_usage_unknown_feature, naming the key', async () => {
      const error = await rejectionOf(
        service.getDetail('notAFeature', presetRange(30)),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      const body = (error as NotFoundException).getResponse() as {
        message: string;
      };
      expect(body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        code: 'feature_usage_unknown_feature',
      });
      expect(body.message).toContain('"notAFeature"');
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('answers an untracked key with feature_usage_feature_not_tracked, naming the key', async () => {
      const error = await rejectionOf(
        service.getDetail('goTogether', presetRange(30)),
      );

      expect(error).toBeInstanceOf(NotFoundException);
      const body = (error as NotFoundException).getResponse() as {
        message: string;
      };
      expect(body).toMatchObject({
        statusCode: 404,
        error: 'Not Found',
        code: 'feature_usage_feature_not_tracked',
      });
      expect(body.message).toContain('"goTogether"');
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getDetail: reach-only feature', () => {
    it('returns createdDaily null for feed and issues zero queries', async () => {
      const detail = await service.getDetail('feed', presetRange(30));

      expect(detail).toEqual({
        featureKey: 'feed',
        rangeDays: 30,
        rangeStart: '2026-09-26',
        rangeEnd: '2026-10-25',
        createdDaily: null,
      });
      expect(dataSource.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('getDetail: rows feature', () => {
    it('runs one grouped query per forum entity and sums both per day', async () => {
      const detail = await service.getDetail('forum', presetRange(30));

      expect(dataSource.createQueryBuilder).toHaveBeenCalledTimes(2);
      expect(recordedQueries.map((query) => query.entity)).toEqual([
        ForumThread,
        ForumPost,
      ]);
      for (const { queryBuilder } of recordedQueries) {
        expect(queryBuilder.groupBy).toHaveBeenCalledTimes(1);
        expect(queryBuilder.getRawMany).toHaveBeenCalledTimes(1);
      }

      const createdDaily = detail.createdDaily ?? [];
      expect(createdDaily).toHaveLength(30);
      // 2026-09-26 is index 0: two threads plus three posts.
      expect(createdDaily[0]).toBe(5);
      expect(createdDaily[14]).toBe(1);
      expect(createdDaily[15]).toBe(6);
      expect(createdDaily[29]).toBe(4);
      expect(sumValues(createdDaily)).toBe(16);
    });

    it('keeps createdDaily at rangeDays entries for a custom range', async () => {
      const range = resolveUsageRange(
        { from: '2026-10-01', to: '2026-10-10' },
        NOW,
        730,
      );

      const detail = await service.getDetail('forum', range);

      expect(detail.rangeDays).toBe(10);
      expect(detail.rangeStart).toBe('2026-10-01');
      expect(detail.rangeEnd).toBe('2026-10-10');
      expect(detail.createdDaily).toHaveLength(10);
    });

    it('groups by the UTC day of createdAt inside [rangeStart, rangeEnd)', async () => {
      const range = presetRange(30);
      await service.getDetail('forum', range);

      const queryBuilder = recordedQueries[0]?.queryBuilder;
      if (!queryBuilder) throw new Error('No detail query was recorded.');
      const [[dayExpression, dayAlias]] = queryBuilder.select.mock.calls as [
        [string, string],
      ];
      expect(dayExpression).toContain("AT TIME ZONE 'UTC'");
      expect(dayAlias).toBe('day');
      expect(queryBuilder.groupBy).toHaveBeenCalledWith(dayExpression);
      expect(queryBuilder.where).toHaveBeenCalledWith(
        'row.createdAt >= :rangeStart',
        { rangeStart: range.rangeStart },
      );
      expect(queryBuilder.andWhere).toHaveBeenCalledWith(
        'row.createdAt < :rangeEnd',
        { rangeEnd: range.rangeEnd },
      );
    });
  });

  describe('invariant: sum(createdDaily) equals depth from getUsage', () => {
    it('uses the same predicates as the depth count and sums to the same number for forum', async () => {
      const range = presetRange(30);
      const usageDataSource = buildDataSource();
      const usageService = new AdminFeatureUsageService(
        {
          createQueryBuilder: jest.fn(() => queryBuilderStub(undefined)),
        } as never,
        usageDataSource.dataSource as unknown as DataSource,
        { get: jest.fn() } as unknown as ConfigService,
      );

      const [usage, detail] = await Promise.all([
        usageService.getUsage(range),
        service.getDetail('forum', range),
      ]);
      const forumRow = usage.features.find(
        (feature) => feature.featureKey === 'forum',
      );

      expect(forumRow?.depth).toBe(sumValues(detail.createdDaily ?? []));

      for (const entity of [ForumThread, ForumPost]) {
        const depthQuery = usageDataSource.recordedQueries.find(
          (query) =>
            query.entity === entity &&
            query.queryBuilder.where.mock.calls.some(
              ([condition]) => condition === 'row.createdAt >= :rangeStart',
            ),
        );
        const detailQuery = recordedQueries.find(
          (query) => query.entity === entity,
        );
        expect(depthQuery).toBeDefined();
        expect(detailQuery).toBeDefined();
        expect(predicatesOf(detailQuery!.queryBuilder)).toEqual(
          predicatesOf(depthQuery!.queryBuilder),
        );
      }
    });
  });
});
