import { ConflictException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModerationService } from './moderation.service';

// Chainable query-builder stub whose terminal method resolves to a
// configurable row list (mirrors `partners.service.spec.ts`'s `qbStub`,
// adapted to `cursorPaginate`'s `getMany()` terminal call).
function qbStub(rows: Report[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['andWhere', 'orderBy', 'addOrderBy', 'take']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  return qb;
}

const baseReport = (overrides: Partial<Report> = {}): Report => ({
  id: 'report-1',
  subjectType: ReportSubjectType.Post,
  subjectId: 'post-1',
  reasonCode: 'harassment',
  detail: 'They kept messaging after being asked to stop.',
  anonymous: false,
  contactEmail: null,
  evidence: null,
  severity: ReportSeverity.High,
  slaDueAt: new Date('2026-01-02T00:00:00.000Z'),
  status: ReportStatus.Open,
  reporterId: 'reporter-1',
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  ...overrides,
});

describe('ModerationService', () => {
  let service: ModerationService;
  let reports: {
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    count: jest.Mock;
  };
  let appeals: {
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  let auditLogs: {
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let users: { findOne: jest.Mock };
  let profiles: { findOne: jest.Mock };

  beforeEach(async () => {
    reports = {
      createQueryBuilder: jest.fn(() => qbStub()),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((r: unknown) => Promise.resolve(r)),
      count: jest.fn().mockResolvedValue(0),
    };
    appeals = {
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((a: unknown) => Promise.resolve(a)),
      create: jest.fn((v: object) => v),
      count: jest.fn().mockResolvedValue(0),
    };
    auditLogs = {
      save: jest.fn((l: unknown) => Promise.resolve(l)),
      create: jest.fn((v: object) => v),
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn().mockResolvedValue(null),
    };
    users = { findOne: jest.fn().mockResolvedValue(null) };
    profiles = { findOne: jest.fn().mockResolvedValue(null) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Appeal), useValue: appeals },
        { provide: getRepositoryToken(ModAuditLog), useValue: auditLogs },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
      ],
    }).compile();
    service = module.get(ModerationService);
  });

  describe('list', () => {
    it('maps tab=open to an open/escalated status filter', async () => {
      const qb = qbStub([baseReport()]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ tab: 'open' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        'r.status IN (:...openStatuses)',
        {
          openStatuses: [ReportStatus.Open, ReportStatus.Escalated],
        },
      );
    });

    it('maps tab=resolved to a resolved status filter', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ tab: 'resolved' });

      expect(qb.andWhere).toHaveBeenCalledWith('r.status = :resolvedStatus', {
        resolvedStatus: ReportStatus.Resolved,
      });
    });

    it('maps tab=appeals to an EXISTS-against-appeals filter', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ tab: 'appeals' });

      expect(qb.andWhere).toHaveBeenCalledWith(
        expect.stringContaining('EXISTS'),
        { appealStatus: AppealStatus.Awaiting },
      );
    });

    it('does not require a tab, subjectType, or severity', async () => {
      const qb = qbStub([baseReport()]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await expect(service.list({})).resolves.toBeDefined();
    });

    it('filters by subjectType, severity, and the emergencies filter when provided', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({
        subjectType: ReportSubjectType.Message,
        severity: ReportSeverity.Medium,
        filter: 'emergencies',
      });

      expect(qb.andWhere).toHaveBeenCalledWith('r.subjectType = :subjectType', {
        subjectType: ReportSubjectType.Message,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('r.severity = :severity', {
        severity: ReportSeverity.Medium,
      });
      expect(qb.andWhere).toHaveBeenCalledWith(
        'r.severity = :emergencySeverity',
        {
          emergencySeverity: ReportSeverity.Emergency,
        },
      );
    });

    it('returns {items, counts, page} with an enriched ModReportDTO per row', async () => {
      const qb = qbStub([baseReport()]);
      reports.createQueryBuilder.mockReturnValue(qb);
      // `list` runs per-row enrichment (which counts prior reports against the
      // same subject) concurrently with the tab counts, so a plain FIFO
      // `mockResolvedValueOnce` queue can't assume call order — branch on the
      // `where` shape instead: `subjectId` → prior-reports lookup, a
      // `FindOperator` (`In(...)`) status → the "open" tab count, a plain
      // status value → the "resolved" tab count.
      reports.count.mockImplementation(
        (opts: { where?: Record<string, unknown> } = {}) => {
          const where = opts.where ?? {};
          if ('subjectId' in where) return Promise.resolve(0);
          if ('status' in where) {
            return Promise.resolve(typeof where.status === 'object' ? 3 : 5);
          }
          return Promise.resolve(0);
        },
      );
      appeals.count.mockResolvedValueOnce(2);

      const page = await service.list({});

      expect(page.items).toEqual([
        expect.objectContaining({
          id: 'report-1',
          severity: ReportSeverity.High,
          reasonCode: 'harassment',
          status: ReportStatus.Open,
        }),
      ]);
      expect(page.items[0].reporter).toEqual({
        anonymous: false,
        id: 'reporter-1',
        name: 'Member',
      });
      expect(page.items[0].reported).toEqual({
        id: 'post-1',
        handle: 'post-1',
        priorReports: 0,
      });
      expect(page.items[0]).not.toHaveProperty('detail');
      expect(page.counts).toEqual({ open: 3, resolved: 5, appeals: 2 });
      expect(page.page).toEqual({ cursor: null });
    });

    it('resolves a non-anonymous reporter name from their profile', async () => {
      const qb = qbStub([baseReport()]);
      reports.createQueryBuilder.mockReturnValue(qb);
      profiles.findOne.mockResolvedValueOnce({
        firstName: 'Ada',
        lastName: 'Lovelace',
      });

      const page = await service.list({});
      expect(page.items[0].reporter).toEqual({
        anonymous: false,
        id: 'reporter-1',
        name: 'Ada Lovelace',
      });
    });

    it('shields an anonymous reporter', async () => {
      const qb = qbStub([baseReport({ anonymous: true })]);
      reports.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list({});
      expect(page.items[0].reporter).toEqual({ anonymous: true });
    });

    it('sets community for community-subject reports and null otherwise', async () => {
      const qb = qbStub([
        baseReport({
          subjectType: ReportSubjectType.Community,
          subjectId: 'my-community',
        }),
      ]);
      reports.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list({});
      expect(page.items[0].community).toBe('my-community');
    });
  });

  describe('getById', () => {
    it('404s an unknown report', async () => {
      reports.findOne.mockResolvedValue(null);
      await expect(service.getById('nope')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('returns an enriched ModReportDTO including the detail block', async () => {
      reports.findOne.mockResolvedValue(baseReport());
      const res = await service.getById('report-1');

      expect(res.id).toBe('report-1');
      expect(res.detail).toEqual(
        expect.objectContaining({
          contentAuthor: 'post-1',
          excerpt: 'They kept messaging after being asked to stop.',
          thread: [],
        }),
      );
      expect(Array.isArray(res.detail?.people)).toBe(true);
    });
  });

  describe('actOnReport', () => {
    it('404s an unknown report', async () => {
      reports.findOne.mockResolvedValue(null);
      await expect(
        service.actOnReport('nope', 'actor-1', {
          action: 'dismiss',
          reasonCode: 'spam',
          note: 'Not a violation.',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('escalate moves the report to escalated', async () => {
      reports.findOne.mockResolvedValue(baseReport());

      const res = await service.actOnReport('report-1', 'actor-1', {
        action: 'escalate',
        reasonCode: 'hate_speech',
        note: 'Needs senior review.',
      });

      expect(res.status).toBe(ReportStatus.Escalated);
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportStatus.Escalated }),
      );
    });

    it('every other action resolves the report and does not include detail', async () => {
      reports.findOne.mockResolvedValue(baseReport());

      const res = await service.actOnReport('report-1', 'actor-1', {
        action: 'remove_content',
        reasonCode: 'hate_speech',
        note: 'Removed the post.',
        duration: undefined,
      });

      expect(res.status).toBe(ReportStatus.Resolved);
      expect(res).not.toHaveProperty('detail');
      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: 'report-1',
          actorId: 'actor-1',
          action: 'remove_content',
          reasonCode: 'hate_speech',
          note: 'Removed the post.',
        }),
      );
    });

    it('persists an optional duration', async () => {
      reports.findOne.mockResolvedValue(baseReport());

      await service.actOnReport('report-1', 'actor-1', {
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Suspended for a week.',
        duration: '7d',
      });

      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({ duration: '7d' }),
      );
    });
  });

  describe('bulkActOnReports', () => {
    it('returns an empty updated list when no ids match', async () => {
      reports.find.mockResolvedValue([]);
      const res = await service.bulkActOnReports('actor-1', {
        ids: ['nope'],
        action: 'dismiss',
        reasonCode: 'spam',
      });
      expect(res).toEqual({ updated: [] });
      expect(auditLogs.save).not.toHaveBeenCalled();
    });

    it('updates every matched report and logs one audit row each', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-1' }),
        baseReport({ id: 'report-2' }),
      ]);

      const res = await service.bulkActOnReports('actor-1', {
        ids: ['report-1', 'report-2'],
        action: 'dismiss',
        reasonCode: 'spam',
        note: 'Bulk dismiss — spam wave.',
      });

      expect(res.updated).toEqual(['report-1', 'report-2']);
      expect(reports.save).toHaveBeenCalledWith([
        expect.objectContaining({
          id: 'report-1',
          status: ReportStatus.Resolved,
        }),
        expect.objectContaining({
          id: 'report-2',
          status: ReportStatus.Resolved,
        }),
      ]);
      expect(auditLogs.save).toHaveBeenCalledTimes(2);
    });

    it('escalates every matched report when the bulk action is escalate', async () => {
      reports.find.mockResolvedValue([baseReport({ id: 'report-1' })]);

      const res = await service.bulkActOnReports('actor-1', {
        ids: ['report-1'],
        action: 'escalate',
        reasonCode: 'hate_speech',
      });

      expect(res.updated).toEqual(['report-1']);
      expect(reports.save).toHaveBeenCalledWith([
        expect.objectContaining({ status: ReportStatus.Escalated }),
      ]);
    });
  });

  describe('auditTrail', () => {
    it('reads the trail for one report, oldest first, renaming createdAt to at and resolving actorName', async () => {
      auditLogs.find.mockResolvedValue([
        {
          id: 'log-1',
          reportId: 'report-1',
          actorId: 'actor-1',
          action: 'remove_content',
          reasonCode: 'hate_speech',
          note: 'Removed.',
          duration: null,
          createdAt: new Date('2026-01-03T00:00:00.000Z'),
        },
      ]);
      profiles.findOne.mockResolvedValueOnce({
        firstName: 'Mod',
        lastName: 'Erator',
      });

      const rows = await service.auditTrail('report-1');

      expect(auditLogs.find).toHaveBeenCalledWith({
        where: { reportId: 'report-1' },
        order: { createdAt: 'ASC' },
      });
      expect(rows).toEqual([
        {
          id: 'log-1',
          reportId: 'report-1',
          actorId: 'actor-1',
          actorName: 'Mod Erator',
          action: 'remove_content',
          reasonCode: 'hate_speech',
          note: 'Removed.',
          at: '2026-01-03T00:00:00.000Z',
        },
      ]);
    });
  });

  describe('listAppeals', () => {
    it('lists appeals newest first', async () => {
      await service.listAppeals();
      expect(appeals.find).toHaveBeenCalledWith({
        order: { createdAt: 'DESC' },
      });
    });
  });

  describe('reviewAppeal', () => {
    const baseAppeal = (overrides: Partial<Appeal> = {}): Appeal => ({
      id: 'appeal-1',
      reportId: 'report-1',
      actionId: 'log-1',
      appellantId: 'member-1',
      severity: ReportSeverity.High,
      community: null,
      argument: 'I was not spamming.',
      status: AppealStatus.Awaiting,
      decision: null,
      createdAt: new Date('2026-01-02T00:00:00.000Z'),
      ...overrides,
    });

    it('404s an unknown appeal', async () => {
      appeals.findOne.mockResolvedValue(null);
      await expect(
        service.reviewAppeal('nope', 'actor-1', {
          decision: 'uphold',
          note: 'n/a',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejects reviewing an already-decided appeal', async () => {
      appeals.findOne.mockResolvedValue(
        baseAppeal({ status: AppealStatus.Upheld }),
      );
      await expect(
        service.reviewAppeal('appeal-1', 'actor-1', {
          decision: 'overturn',
          note: 'n/a',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('upholds, logs against the linked report, and returns the enriched AppealDTO', async () => {
      appeals.findOne.mockResolvedValue(baseAppeal());
      auditLogs.findOne.mockResolvedValue({
        id: 'log-1',
        reportId: 'report-1',
        actorId: 'actor-2',
        action: 'remove_content',
        reasonCode: 'hate_speech',
        note: null,
        duration: null,
        createdAt: new Date('2026-01-01T12:00:00.000Z'),
      });
      profiles.findOne
        .mockResolvedValueOnce({ slug: 'appellant-slug', pronouns: 'she/her' }) // appellant
        .mockResolvedValueOnce({ firstName: 'Mod', lastName: 'Erator' }); // original actor

      const res = await service.reviewAppeal('appeal-1', 'actor-1', {
        decision: 'uphold',
        note: 'Evidence supports the original action.',
      });

      expect(res.status).toBe(AppealStatus.Upheld);
      expect(res.argument).toBe('I was not spamming.');
      expect(res.appellant).toEqual({
        handle: 'appellant-slug',
        pronoun: 'she/her',
      });
      expect(res.original).toEqual({
        action: 'remove_content',
        by: 'Mod Erator',
        when: '2026-01-01T12:00:00.000Z',
        reason: 'hate_speech',
      });
      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: 'report-1',
          actorId: 'actor-1',
          action: 'appeal_upheld',
        }),
      );
    });

    it('overturns and skips the audit log when there is no linked report', async () => {
      appeals.findOne.mockResolvedValue(
        baseAppeal({ reportId: null, actionId: null, appellantId: null }),
      );

      const res = await service.reviewAppeal('appeal-1', 'actor-1', {
        decision: 'overturn',
        note: 'n/a',
      });

      expect(res.status).toBe(AppealStatus.Overturned);
      expect(res.reportId).toBe('');
      expect(res.actionId).toBe('');
      expect(res.appellant).toEqual({ handle: 'member' });
      expect(auditLogs.save).not.toHaveBeenCalled();
    });
  });
});
