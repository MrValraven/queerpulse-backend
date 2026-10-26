import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { AdminCommunitiesService } from '../admin-communities/admin-communities.service';
import { GovernanceFinanceService } from '../governance/governance-finance.service';
import { Report } from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { AdminReportsService } from './admin-reports.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');
const BASELINE_MEMBER_COUNT = 300;

function daysAgo(days: number): Date {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS);
}

interface MockRepo {
  count: jest.Mock;
  find: jest.Mock;
}

function makeMockRepo(): MockRepo {
  return {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
  };
}

describe('AdminReportsService', () => {
  let service: AdminReportsService;
  let profiles: MockRepo;
  let reports: MockRepo;

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    profiles = makeMockRepo();
    reports = makeMockRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminReportsService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Report), useValue: reports },
        {
          provide: AdminCommunitiesService,
          useValue: { listCommunities: jest.fn() },
        },
        {
          provide: GovernanceFinanceService,
          useValue: { getAdminFinances: jest.fn() },
        },
      ],
    }).compile();

    service = module.get(AdminReportsService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getGrowth', () => {
    it('reports member growth as a running total: the pre-window baseline plus cumulative weekly joins', async () => {
      profiles.count.mockResolvedValue(BASELINE_MEMBER_COUNT);
      const growthWindowJoins = [
        { joinedAt: daysAgo(20) },
        { joinedAt: daysAgo(3) },
        { joinedAt: daysAgo(1) },
      ];
      profiles.find.mockResolvedValue(growthWindowJoins);

      const growth = await service.getGrowth(4);

      expect(growth.range).toBe(4);
      expect(growth.points.map((point) => point.joined)).toEqual([0, 1, 0, 2]);
      expect(growth.points.map((point) => point.total)).toEqual([
        300, 301, 301, 303,
      ]);
      expect(growth.points[growth.points.length - 1]?.total).toBe(
        BASELINE_MEMBER_COUNT + growthWindowJoins.length,
      );
      for (const point of growth.points) {
        expect(point.churned).toBeNull();
        expect(point).not.toHaveProperty('spike');
      }
    });

    it('counts the baseline at or before the window start, over the same joinedAt population', async () => {
      await service.getGrowth(4);

      const windowStart = new Date(FIXED_NOW.getTime() - 4 * 7 * DAY_MS);
      const countCalls = profiles.count.mock.calls as [
        { where: { joinedAt: { type: string; value: Date } } },
      ][];
      const countOptions = countCalls[0]![0];
      expect(countOptions.where.joinedAt.type).toBe('lessThanOrEqual');
      expect(countOptions.where.joinedAt.value).toEqual(windowStart);
    });

    it('starts the total at zero on a platform with no members yet', async () => {
      const growth = await service.getGrowth(8);

      expect(growth.points).toHaveLength(8);
      for (const point of growth.points) {
        expect(point.joined).toBe(0);
        expect(point.total).toBe(0);
      }
    });
  });

  describe('getGrowthCsv', () => {
    it('exports week_start, joined and total columns', async () => {
      profiles.count.mockResolvedValue(BASELINE_MEMBER_COUNT);
      profiles.find.mockResolvedValue([{ joinedAt: daysAgo(1) }]);

      const csv = await service.getGrowthCsv(4);
      const csvRows = csv.split('\n');

      expect(csvRows[0]).toBe('"week_start","joined","total"');
      expect(csvRows).toHaveLength(5);
      expect(csvRows[1]).toMatch(/,"0","300"$/);
      expect(csvRows[4]).toMatch(/,"1","301"$/);
    });
  });
});
