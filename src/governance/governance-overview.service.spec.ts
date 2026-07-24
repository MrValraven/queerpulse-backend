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
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('GovernanceOverviewService', () => {
  let service: GovernanceOverviewService;
  let repo: { findOne: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn() };
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
      });
    });

    it('404s when the overview has not been seeded', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getOverview()).rejects.toThrow(NotFoundException);
    });
  });
});
