import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource, IsNull } from 'typeorm';
import { AdminFeatureUsageService } from './admin-feature-usage.service';
import { FeatureUsageDaily } from './entities/feature-usage-daily.entity';

// A chainable query-builder stub, resolving every terminal method to an empty
// value. Mirrors `landing.service.spec.ts`'s `qbStub`. Shared by every
// `dataSource.createQueryBuilder(...)` call `getUsage` makes across its many
// depth/drill-down entities.
function qbStub() {
  const queryBuilder: Record<string, jest.Mock> = {};
  for (const method of [
    'select',
    'addSelect',
    'where',
    'andWhere',
    'groupBy',
  ]) {
    queryBuilder[method] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getCount = jest.fn().mockResolvedValue(0);
  queryBuilder.getRawMany = jest.fn().mockResolvedValue([]);
  return queryBuilder;
}

describe('AdminFeatureUsageService', () => {
  let service: AdminFeatureUsageService;
  let featureUsageDailies: { createQueryBuilder: jest.Mock };
  let dataSource: {
    createQueryBuilder: jest.Mock;
    getRepository: jest.Mock;
  };
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

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminFeatureUsageService,
        {
          provide: getRepositoryToken(FeatureUsageDaily),
          useValue: featureUsageDailies,
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(AdminFeatureUsageService);
  });

  describe('getUsage: communities drill-down', () => {
    it('excludes spaces (subcommunities) from the "still posting this week" count', async () => {
      await service.getUsage(7);

      const [{ where }] = communityRepositoryCount.mock.calls[0] as [
        { where: { parentId?: unknown } },
      ];
      expect(where.parentId).toEqual(IsNull());
    });
  });
});
