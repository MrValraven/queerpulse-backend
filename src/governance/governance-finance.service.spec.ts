import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceFinanceReport } from './entities/governance-finance-report.entity';
import { governanceFinanceReportSeed } from './governance-finance.seed';

function makeReport(
  overrides: Partial<GovernanceFinanceReport> = {},
): GovernanceFinanceReport {
  return {
    id: 'r1',
    quarter: governanceFinanceReportSeed.quarter,
    stats: governanceFinanceReportSeed.stats,
    income: governanceFinanceReportSeed.income,
    expense: governanceFinanceReportSeed.expense,
    eventNotes: governanceFinanceReportSeed.eventNotes,
    reserve: governanceFinanceReportSeed.reserve,
    partners: governanceFinanceReportSeed.partners,
    publishedAt: governanceFinanceReportSeed.publishedAt,
    createdAt: governanceFinanceReportSeed.publishedAt,
    updatedAt: governanceFinanceReportSeed.publishedAt,
    ...overrides,
  };
}

describe('GovernanceFinanceService', () => {
  let service: GovernanceFinanceService;
  let repo: { findOne: jest.Mock; find: jest.Mock };

  beforeEach(async () => {
    repo = { findOne: jest.fn(), find: jest.fn() };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceFinanceService,
        {
          provide: getRepositoryToken(GovernanceFinanceReport),
          useValue: repo,
        },
      ],
    }).compile();
    service = module.get(GovernanceFinanceService);
  });

  describe('getFinances', () => {
    it('fetches the most recently published report when no quarter is given', async () => {
      const report = makeReport();
      repo.find.mockResolvedValue([report]);

      const result = await service.getFinances();

      // The "latest" path has no selection conditions, so it must go through
      // `find({ take: 1 })` — `findOne` without a `where` throws in TypeORM 0.3.
      expect(repo.find).toHaveBeenCalledWith({
        order: { publishedAt: 'DESC' },
        take: 1,
      });
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(result).toEqual({
        quarter: '2026-Q2',
        stats: governanceFinanceReportSeed.stats,
        income: governanceFinanceReportSeed.income,
        expense: governanceFinanceReportSeed.expense,
        eventNotes: governanceFinanceReportSeed.eventNotes,
        reserve: governanceFinanceReportSeed.reserve,
        partners: governanceFinanceReportSeed.partners,
        publishedAt: governanceFinanceReportSeed.publishedAt.toISOString(),
      });
    });

    it('fetches an exact quarter when one is given', async () => {
      const report = makeReport({ quarter: '2026-Q1' });
      repo.findOne.mockResolvedValue(report);

      const result = await service.getFinances('2026-Q1');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { quarter: '2026-Q1' },
      });
      expect(result.quarter).toBe('2026-Q1');
    });

    it('404s when no report exists yet', async () => {
      repo.find.mockResolvedValue([]);
      await expect(service.getFinances()).rejects.toThrow(NotFoundException);
    });

    it('404s when the requested quarter has no report', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getFinances('2099-Q1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });
});
