import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GovernanceOverviewService } from './governance-overview.service';
import {
  GOVERNANCE_OVERVIEW_ID,
  GovernanceOverview,
} from './entities/governance-overview.entity';
import { governanceOverviewSeed } from './governance-overview.seed';

function makeOverview(
  overrides: Partial<GovernanceOverview> = {},
): GovernanceOverview {
  return {
    id: GOVERNANCE_OVERVIEW_ID,
    health: governanceOverviewSeed.health,
    moderationSteps: governanceOverviewSeed.moderationSteps,
    council: governanceOverviewSeed.council,
    principles: governanceOverviewSeed.principles,
    decisions: governanceOverviewSeed.decisions,
    publishedAt: null,
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GovernanceOverviewService', () => {
  let service: GovernanceOverviewService;
  let repo: { findOne: jest.Mock; save: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn(), save: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceOverviewService,
        {
          provide: getRepositoryToken(GovernanceOverview),
          useValue: repo,
        },
      ],
    }).compile();
    service = module.get(GovernanceOverviewService);
  });

  describe('getOverview', () => {
    it('fetches the singleton row by its fixed id and maps it to the DTO', async () => {
      repo.findOne.mockResolvedValue(makeOverview());

      const result = await service.getOverview();

      // The singleton lookup must carry a `where` (keyed on the fixed id) — a
      // bare `findOne` throws "you must provide selection conditions".
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: GOVERNANCE_OVERVIEW_ID },
      });
      expect(result).toEqual({
        health: governanceOverviewSeed.health,
        moderationSteps: governanceOverviewSeed.moderationSteps,
        council: governanceOverviewSeed.council,
        principles: governanceOverviewSeed.principles,
        decisions: governanceOverviewSeed.decisions,
        publishedAt: null,
      });
    });

    it('maps a published snapshot to an ISO `publishedAt`', async () => {
      const publishedAt = new Date('2026-08-05T10:00:00.000Z');
      repo.findOne.mockResolvedValue(makeOverview({ publishedAt }));

      const result = await service.getOverview();

      expect(result.publishedAt).toBe(publishedAt.toISOString());
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getOverview()).rejects.toThrow(NotFoundException);
    });
  });

  describe('publish', () => {
    it('stamps `publishedAt` on the singleton and returns the ISO timestamp', async () => {
      const overview = makeOverview();
      repo.findOne.mockResolvedValue(overview);
      repo.save.mockImplementation(async (row: GovernanceOverview) => row);

      const before = Date.now();
      const result = await service.publish();
      const after = Date.now();

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: GOVERNANCE_OVERVIEW_ID },
      });
      expect(repo.save).toHaveBeenCalledWith(overview);
      expect(overview.publishedAt).toBeInstanceOf(Date);
      const stamped = new Date(result.publishedAt).getTime();
      expect(stamped).toBeGreaterThanOrEqual(before);
      expect(stamped).toBeLessThanOrEqual(after);
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.publish()).rejects.toThrow(NotFoundException);
    });
  });
});
