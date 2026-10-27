import { ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AdminFeatureUsageService } from './admin-feature-usage.service';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';
import { resolveUsageRange, UsageRange } from './feature-usage-range';

const NOW = new Date('2026-10-26T15:00:00Z');

interface GroupedReachRow {
  day: string;
  featureKey: string;
  total: string;
}

// A chainable query-builder stub, resolving every terminal method to an empty
// value unless `rawRows` is given. Mirrors `landing.service.spec.ts`'s
// `qbStub`. Shared by every `dataSource.createQueryBuilder(...)` call
// `getUsage` makes across its many depth/drill-down entities, and by the one
// grouped `feature_usage_daily` read.
function qbStub(rawRows: GroupedReachRow[] = []) {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
    'addGroupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getCount = jest.fn().mockResolvedValue(0);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue(rawRows);
  return queryBuilder;
}

function presetRange(rangeDays: number): UsageRange {
  return resolveUsageRange({ rangeDays: String(rangeDays) }, NOW, 730);
}

function sumValues(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function medianOf(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((first, second) => first - second);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
    : (sorted[middle] ?? 0);
}

describe('AdminFeatureUsageService', () => {
  let service: AdminFeatureUsageService;
  let featureUsageDailies: { createQueryBuilder: jest.Mock };
  let dataSource: {
    createQueryBuilder: jest.Mock;
    getRepository: jest.Mock;
  };
  let config: { get: jest.Mock };
  let communityRepositoryCount: jest.Mock;

  beforeEach(async () => {
    featureUsageDailies = { createQueryBuilder: jest.fn(() => qbStub()) };
    communityRepositoryCount = jest.fn().mockResolvedValue(0);
    dataSource = {
      createQueryBuilder: jest.fn(() => qbStub()),
      // Only `communitiesStillPostingThisWeekCount` counts through
      // `dataSource.getRepository(Community).count(...)`; every other
      // entity's count is a `createQueryBuilder` `qbStub`.
      getRepository: jest.fn(() => ({ count: communityRepositoryCount })),
    };
    config = {
      get: jest.fn((_key: string, fallback: unknown) => fallback),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFeatureUsageService,
        {
          provide: getRepositoryToken(FeatureUsageDaily),
          useValue: featureUsageDailies,
        },
        { provide: DataSource, useValue: dataSource },
        { provide: ConfigService, useValue: config },
      ],
    }).compile();
    service = module.get(AdminFeatureUsageService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getUsage: feature rows', () => {
    it('lists no row for Go together, which is never measured', async () => {
      const usage = await service.getUsage(presetRange(7));

      const featureKeys = usage.features.map((feature) => feature.featureKey);
      expect(featureKeys).toContain('events');
      expect(featureKeys).not.toContain('goTogether');
    });
  });

  describe('getUsage: daily reach', () => {
    it('reads feature_usage_daily exactly once, across both windows', async () => {
      const range = presetRange(30);
      await service.getUsage(range);

      expect(featureUsageDailies.createQueryBuilder).toHaveBeenCalledTimes(1);
      const dailyQueryBuilder = featureUsageDailies.createQueryBuilder.mock
        .results[0]?.value as Record<string, jest.Mock>;
      expect(dailyQueryBuilder.where).toHaveBeenCalledWith(
        'daily.day >= :start',
        { start: '2026-08-27' },
      );
      expect(dailyQueryBuilder.andWhere).toHaveBeenCalledWith(
        'daily.day < :end',
        { end: '2026-10-26' },
      );
    });

    it('gives every feature a zero-filled daily series of rangeDays entries', async () => {
      const usage = await service.getUsage(presetRange(30));

      expect(usage.features.length).toBeGreaterThan(0);
      for (const feature of usage.features) {
        expect(feature.reachDaily).toHaveLength(30);
        expect(feature.reachPreviousDaily).toHaveLength(30);
        expect(feature.reach).toBe(0);
        expect(feature.reachPrevious).toBe(0);
      }
    });

    it('splits grouped rows into aligned current and previous series whose sums are reach and reachPrevious', async () => {
      featureUsageDailies.createQueryBuilder.mockImplementation(() =>
        qbStub([
          // Current window, 2026-09-26 to 2026-10-25.
          { day: '2026-09-26', featureKey: 'forum', total: '5' },
          { day: '2026-10-25', featureKey: 'forum', total: '7' },
          { day: '2026-10-01', featureKey: 'feed', total: '40' },
          // Previous window, 2026-08-27 to 2026-09-25.
          { day: '2026-08-27', featureKey: 'forum', total: '3' },
          { day: '2026-09-25', featureKey: 'forum', total: '2' },
          // Outside both windows: never counted.
          { day: '2026-10-26', featureKey: 'forum', total: '999' },
        ]),
      );

      const usage = await service.getUsage(presetRange(30));
      const forum = usage.features.find(
        (feature) => feature.featureKey === 'forum',
      );
      const feed = usage.features.find(
        (feature) => feature.featureKey === 'feed',
      );

      expect(forum?.reachDaily[0]).toBe(5);
      expect(forum?.reachDaily[29]).toBe(7);
      expect(forum?.reachPreviousDaily[0]).toBe(3);
      expect(forum?.reachPreviousDaily[29]).toBe(2);
      expect(forum?.reach).toBe(12);
      expect(forum?.reachPrevious).toBe(5);
      expect(feed?.reachDaily[5]).toBe(40);
      expect(feed?.reach).toBe(40);

      for (const feature of usage.features) {
        expect(feature.reach).toBe(sumValues(feature.reachDaily));
        expect(feature.reachPrevious).toBe(
          sumValues(feature.reachPreviousDaily),
        );
      }
    });

    it('reports reachMedian as the median reach of launched features', async () => {
      featureUsageDailies.createQueryBuilder.mockImplementation(() =>
        qbStub([
          { day: '2026-10-20', featureKey: 'forum', total: '120' },
          { day: '2026-10-21', featureKey: 'feed', total: '400' },
          { day: '2026-10-22', featureKey: 'magazine', total: '33' },
        ]),
      );

      const usage = await service.getUsage(presetRange(30));
      const launchedReaches = usage.features
        .filter((feature) => feature.isLaunched)
        .map((feature) => feature.reach);

      expect(usage.reachMedian).toBe(medianOf(launchedReaches));
    });

    it('carries the inclusive range dates of the worked example', async () => {
      const usage = await service.getUsage(presetRange(30));

      expect(usage).toMatchObject({
        rangeDays: 30,
        rangeStart: '2026-09-26',
        rangeEnd: '2026-10-25',
        previousRangeStart: '2026-08-27',
        previousRangeEnd: '2026-09-25',
        retentionStart: '2024-10-26',
        isPreviousRangePartial: false,
      });
    });
  });

  describe('resolveRange', () => {
    it('reads the retention window from config and the clock from now', () => {
      config.get.mockReturnValue(100);
      jest.useFakeTimers().setSystemTime(NOW);

      const range = service.resolveRange({ rangeDays: '7' });

      expect(config.get).toHaveBeenCalledWith(
        'retention.featureUsageDays',
        730,
      );
      expect(range.rangeDays).toBe(7);
      expect(range.retentionStart.toISOString()).toBe(
        '2026-07-18T00:00:00.000Z',
      );
      expect(range.rangeEnd.toISOString()).toBe('2026-10-26T00:00:00.000Z');
    });
  });

  describe('getUsage: communities drill-down', () => {
    it('excludes spaces (subcommunities) from the "still posting this week" count', async () => {
      await service.getUsage(presetRange(7));

      const [{ where }] = communityRepositoryCount.mock.calls[0] as [
        { where: { parentId?: unknown } },
      ];
      expect(where.parentId).toEqual(IsNull());
    });
  });
});
