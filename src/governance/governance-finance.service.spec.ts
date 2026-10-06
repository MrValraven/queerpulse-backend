import { ConflictException, NotFoundException } from '@nestjs/common';
import { DataSource, Not } from 'typeorm';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Profile } from '../users/entities/profile.entity';
import { GovernanceFinanceService } from './governance-finance.service';
import { GovernanceFinanceChange } from './entities/governance-finance-change.entity';
import {
  FinanceLine,
  FinanceMetricSource,
  GovernanceFinanceReport,
} from './entities/governance-finance-report.entity';
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
    incomeTotal: null,
    expenseTotal: null,
    surplus: null,
    mrr: null,
    sustainerCount: null,
    solidarityRate: null,
    mrrSource: FinanceMetricSource.Seeded,
    sustainerCountSource: FinanceMetricSource.Seeded,
    solidarityRateSource: FinanceMetricSource.Seeded,
    incomeTotalSource: FinanceMetricSource.Seeded,
    expenseTotalSource: FinanceMetricSource.Seeded,
    metricsEditedBy: null,
    metricsEditedAt: null,
    publishedAt: governanceFinanceReportSeed.publishedAt,
    createdAt: governanceFinanceReportSeed.publishedAt,
    updatedAt: governanceFinanceReportSeed.publishedAt,
    ...overrides,
  };
}

describe('GovernanceFinanceService', () => {
  let service: GovernanceFinanceService;
  let repo: { findOne: jest.Mock; find: jest.Mock };
  let dataSource: { transaction: jest.Mock };
  // The transaction's entity manager, for the write paths below.
  let manager: {
    find: jest.Mock;
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
  };

  beforeEach(async () => {
    repo = { findOne: jest.fn(), find: jest.fn() };
    manager = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn((_entity: unknown, row: object) => ({ ...row })),
      save: jest.fn((row: unknown) => Promise.resolve(row)),
    };
    dataSource = {
      transaction: jest.fn(
        (work: (transactionManager: typeof manager) => Promise<unknown>) =>
          work(manager),
      ),
    };
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        GovernanceFinanceService,
        {
          provide: getRepositoryToken(GovernanceFinanceReport),
          useValue: repo,
        },
        {
          provide: getRepositoryToken(GovernanceFinanceChange),
          useValue: { find: jest.fn() },
        },
        {
          provide: getRepositoryToken(Profile),
          useValue: { find: jest.fn().mockResolvedValue([]) },
        },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();
    service = module.get(GovernanceFinanceService);
  });

  // PRD-447. The public endpoint serves only a report whose five headline
  // figures were all entered by people. The seeded report (every source still
  // `seeded`) never reaches it.
  const ENTERED_BY_PEOPLE_WHERE = {
    mrrSource: Not(FinanceMetricSource.Seeded),
    sustainerCountSource: Not(FinanceMetricSource.Seeded),
    solidarityRateSource: Not(FinanceMetricSource.Seeded),
    incomeTotalSource: Not(FinanceMetricSource.Seeded),
    expenseTotalSource: Not(FinanceMetricSource.Seeded),
  };

  const enteredSources = {
    mrrSource: FinanceMetricSource.Manual,
    sustainerCountSource: FinanceMetricSource.Manual,
    solidarityRateSource: FinanceMetricSource.Manual,
    incomeTotalSource: FinanceMetricSource.Manual,
    expenseTotalSource: FinanceMetricSource.Manual,
  };

  describe('getFinances', () => {
    it('reads the newest report whose figures were entered by people', async () => {
      const enteredAt = new Date('2026-10-02T09:30:00.000Z');
      const report = makeReport({
        ...enteredSources,
        metricsEditedAt: enteredAt,
      });
      repo.find.mockResolvedValue([report]);

      const result = await service.getFinances();

      // The "latest" path has no keyed lookup, so it goes through
      // `find({ take: 1 })`, filtered to reports nobody left seeded.
      expect(repo.find).toHaveBeenCalledWith({
        where: ENTERED_BY_PEOPLE_WHERE,
        order: { publishedAt: 'DESC' },
        take: 1,
      });
      expect(repo.findOne).not.toHaveBeenCalled();
      // Public lines carry no line-item breakdown or total label (only the
      // seed ever wrote those), and the seeded partners, which carry only an
      // i18n `scopeKey`, are dropped.
      const withoutBreakdown = (lines: FinanceLine[]) =>
        lines.map((line) => ({
          ...line,
          items: [],
          total: { label: '', amount: line.total.amount },
        }));
      expect(result).toEqual({
        quarter: '2026-Q2',
        stats: governanceFinanceReportSeed.stats,
        income: withoutBreakdown(governanceFinanceReportSeed.income),
        expense: withoutBreakdown(governanceFinanceReportSeed.expense),
        eventNotes: governanceFinanceReportSeed.eventNotes,
        reserve: governanceFinanceReportSeed.reserve,
        partners: [],
        incomeTotal: null,
        expenseTotal: null,
        surplus: null,
        mrr: null,
        sustainerCount: null,
        solidarityRate: null,
        publishedAt: governanceFinanceReportSeed.publishedAt.toISOString(),
        // The public page labels the report with who entered it and when.
        provenance: {
          source: FinanceMetricSource.Manual,
          enteredAt: enteredAt.toISOString(),
        },
      });
    });

    it('answers with the empty report when nothing has been entered yet', async () => {
      repo.find.mockResolvedValue([]);

      const result = await service.getFinances();

      // Same shape, every field empty: the page renders "nothing published
      // yet" from `quarter: null`.
      expect(result).toEqual({
        quarter: null,
        stats: [],
        income: [],
        expense: [],
        eventNotes: [],
        reserve: null,
        partners: [],
        incomeTotal: null,
        expenseTotal: null,
        surplus: null,
        mrr: null,
        sustainerCount: null,
        solidarityRate: null,
        publishedAt: null,
        provenance: null,
      });
    });

    it('leaves a ledger row an admin switched off out of the public report', async () => {
      const [shownLine, hiddenLine] = governanceFinanceReportSeed.income;
      repo.find.mockResolvedValue([
        makeReport({
          ...enteredSources,
          income: [shownLine!, { ...hiddenLine!, enabled: false }],
        }),
      ]);

      const result = await service.getFinances();

      expect(result.income.map((line) => line.label)).toEqual([
        shownLine!.label,
      ]);
    });

    it('publishes a keyed partner an admin saved, keeping its translation key', async () => {
      const [seededPartner] = governanceFinanceReportSeed.partners;
      repo.find.mockResolvedValue([
        makeReport({
          ...enteredSources,
          partners: [
            { ...seededPartner!, source: FinanceMetricSource.Manual },
            ...governanceFinanceReportSeed.partners.slice(1),
          ],
        }),
      ]);

      const result = await service.getFinances();

      // The internal `source` marker stays off the public response, and the
      // still-seeded partners stay off the page.
      expect(result.partners).toEqual([
        {
          name: seededPartner!.name,
          amount: seededPartner!.amount,
          scopeKey: seededPartner!.scopeKey,
        },
      ]);
    });

    it('keeps a partner whose restriction an admin typed', async () => {
      repo.find.mockResolvedValue([
        makeReport({
          ...enteredSources,
          partners: [
            {
              name: 'A local foundation',
              amount: 400,
              scope: 'the wellbeing fund',
            },
            ...governanceFinanceReportSeed.partners,
          ],
        }),
      ]);

      const result = await service.getFinances();

      expect(result.partners).toEqual([
        {
          name: 'A local foundation',
          amount: 400,
          scope: 'the wellbeing fund',
        },
      ]);
    });

    it('fetches an exact quarter when one is given, still only if entered', async () => {
      const report = makeReport({ ...enteredSources, quarter: '2026-Q1' });
      repo.findOne.mockResolvedValue(report);

      const result = await service.getFinances('2026-Q1');

      expect(repo.findOne).toHaveBeenCalledWith({
        where: { quarter: '2026-Q1', ...ENTERED_BY_PEOPLE_WHERE },
      });
      expect(result.quarter).toBe('2026-Q1');
    });

    it('404s when the requested quarter has no public report', async () => {
      repo.findOne.mockResolvedValue(null);
      await expect(service.getFinances('2099-Q1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  describe('getAdminFinances', () => {
    it('keeps a seeded report on the admin tab and says it is not public', async () => {
      repo.find.mockResolvedValue([makeReport()]);

      const result = await service.getAdminFinances();

      expect(result.latest?.quarter).toBe('2026-Q2');
      expect(result.latest?.isPublic).toBe(false);
      // The tiles, notes and disclosures travel to the editor too.
      expect(result.latest?.stats).toEqual(governanceFinanceReportSeed.stats);
      expect(result.latest?.partners).toEqual(
        governanceFinanceReportSeed.partners,
      );
    });

    it('marks a report public once every headline figure was entered', async () => {
      repo.find.mockResolvedValue([makeReport(enteredSources)]);

      const result = await service.getAdminFinances();

      expect(result.latest?.isPublic).toBe(true);
    });
  });

  describe('getAdminFinances figures', () => {
    it('leaves a quarter with no entered totals out of the chart series', async () => {
      repo.find.mockResolvedValue([
        makeReport({
          quarter: '2026-Q3',
          incomeTotal: null,
          expenseTotal: null,
        }),
        makeReport({
          quarter: '2026-Q2',
          incomeTotal: 4620,
          expenseTotal: 4150,
        }),
      ]);

      const result = await service.getAdminFinances();

      expect(result.history.map((point) => point.quarter)).toEqual(['2026-Q2']);
    });

    it('sends a figure nobody entered as null, so the editor shows it empty', async () => {
      repo.find.mockResolvedValue([makeReport({ mrr: null })]);

      const result = await service.getAdminFinances();

      expect(result.latest?.mrr).toBeNull();
    });
  });

  describe('updateAdminFinances', () => {
    it('flips a still-seeded figure to manual when it is resubmitted unchanged', async () => {
      const report = makeReport({ mrr: 0 });
      manager.find.mockResolvedValue([report]);
      repo.find.mockResolvedValue([report]);

      await service.updateAdminFinances({ mrr: 0 }, 'admin-1');

      expect(report.mrrSource).toBe(FinanceMetricSource.Manual);
      expect(manager.create).toHaveBeenCalledWith(
        GovernanceFinanceChange,
        expect.objectContaining({ field: 'mrr', oldValue: '0', newValue: '0' }),
      );
    });

    it('skips an already-entered figure resubmitted as it is', async () => {
      const report = makeReport({
        mrr: 1840,
        mrrSource: FinanceMetricSource.Manual,
      });
      manager.find.mockResolvedValue([report]);
      repo.find.mockResolvedValue([report]);

      await service.updateAdminFinances({ mrr: 1840 }, 'admin-1');

      expect(manager.save).not.toHaveBeenCalled();
    });

    it('records the report id on every audit row', async () => {
      const report = makeReport({ mrr: 1840 });
      manager.find.mockResolvedValue([report]);
      repo.find.mockResolvedValue([report]);

      await service.updateAdminFinances(
        { mrr: 2100, eventNotes: [{ title: 'Hosts keep it all', body: '' }] },
        'admin-1',
      );

      expect(manager.create).toHaveBeenCalledWith(
        GovernanceFinanceChange,
        expect.objectContaining({ field: 'mrr', reportId: 'r1' }),
      );
      expect(manager.create).toHaveBeenCalledWith(
        GovernanceFinanceChange,
        expect.objectContaining({ field: 'eventNotes', reportId: 'r1' }),
      );
    });

    it('stamps the figures-entered date when a figure changes', async () => {
      const report = makeReport({ mrr: 1840 });
      manager.find.mockResolvedValue([report]);
      repo.find.mockResolvedValue([report]);

      await service.updateAdminFinances({ mrr: 2100 }, 'admin-1');

      expect(report.metricsEditedBy).toBe('admin-1');
      expect(report.metricsEditedAt).toBeInstanceOf(Date);
    });

    it('leaves the figures-entered date alone on a prose-only save', async () => {
      const enteredAt = new Date('2026-10-02T09:30:00.000Z');
      const report = makeReport({
        ...enteredSources,
        metricsEditedBy: 'admin-0',
        metricsEditedAt: enteredAt,
      });
      manager.find.mockResolvedValue([report]);
      repo.find.mockResolvedValue([report]);

      await service.updateAdminFinances(
        {
          stats: [
            { n: '€4,150', l: 'Total expenditure', trend: '', up: false },
          ],
          eventNotes: [{ title: 'Hosts keep it all', body: '' }],
          partners: [
            {
              name: 'A local foundation',
              amount: 400,
              scope: 'the wellbeing fund',
            },
          ],
          reserve: { current: 100, target: 1000 },
        },
        'admin-1',
      );

      // The words are saved and audited, but the public date and the editor
      // badge still point at the last figure entry.
      expect(manager.save).toHaveBeenCalledWith(report);
      expect(report.metricsEditedAt).toBe(enteredAt);
      expect(report.metricsEditedBy).toBe('admin-0');
    });
  });

  describe('openQuarter', () => {
    it('refuses while the newest quarter is still not public', async () => {
      manager.findOne.mockResolvedValue(null);
      manager.find.mockResolvedValue([makeReport()]);

      await expect(
        service.openQuarter({ quarter: '2026-Q3' }, 'admin-1'),
      ).rejects.toThrow(ConflictException);
      expect(manager.save).not.toHaveBeenCalled();
    });

    it('opens the next quarter once the newest one is public', async () => {
      manager.findOne.mockResolvedValue(null);
      manager.find.mockResolvedValue([makeReport(enteredSources)]);
      repo.find.mockResolvedValue([]);

      await service.openQuarter({ quarter: '2026-Q3' }, 'admin-1');

      expect(manager.create).toHaveBeenCalledWith(
        GovernanceFinanceReport,
        expect.objectContaining({
          quarter: '2026-Q3',
          income: [],
          expense: [],
        }),
      );
    });

    it('records the new report id on the quarter-opened audit row', async () => {
      manager.findOne.mockResolvedValue(null);
      manager.find.mockResolvedValue([makeReport(enteredSources)]);
      repo.find.mockResolvedValue([]);
      manager.save.mockImplementationOnce((row: object) =>
        Promise.resolve({ ...row, id: 'r2' }),
      );

      await service.openQuarter({ quarter: '2026-Q3' }, 'admin-1');

      expect(manager.create).toHaveBeenCalledWith(
        GovernanceFinanceChange,
        expect.objectContaining({ field: 'quarter', reportId: 'r2' }),
      );
    });

    it('answers a lost unique-index race with 409', async () => {
      manager.findOne.mockResolvedValue(null);
      manager.find.mockResolvedValue([]);
      manager.save.mockRejectedValueOnce({
        code: '23505',
        constraint: 'UQ_governance_finance_report_quarter',
      });

      await expect(
        service.openQuarter({ quarter: '2026-Q3' }, 'admin-1'),
      ).rejects.toThrow(ConflictException);
    });
  });
});
