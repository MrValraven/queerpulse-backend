import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AuthService } from '../auth/auth.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserStatus } from '../users/entities/user.entity';
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
  let revokeAllForUser: jest.Mock;
  let managerUpdate: jest.Mock;

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
    revokeAllForUser = jest.fn().mockResolvedValue(undefined);
    managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });

    // `actOnReport`/`bulkActOnReports`/`reviewAppeal` now run inside
    // `dataSource.transaction` so the report status, the enforcement against
    // the member, and the audit row commit together. This manager double
    // delegates back to the same repository stubs, so assertions written
    // against `reports.save` / `auditLogs.save` keep working unchanged.
    const manager = {
      save: (e: unknown): Promise<unknown> => {
        const sample = Array.isArray(e) ? (e[0] as object) : (e as object);
        // Reports carry `subjectType`; appeals do not. Enough to route a
        // double, and it keeps both entities' existing assertions intact.
        return sample && 'subjectType' in sample
          ? (reports.save(e) as Promise<unknown>)
          : (appeals.save(e) as Promise<unknown>);
      },
      update: managerUpdate,
      findOne: (entity: unknown, opts: unknown): Promise<unknown> =>
        entity === User
          ? (users.findOne(opts) as Promise<unknown>)
          : (reports.findOne(opts) as Promise<unknown>),
      getRepository: (entity: unknown) =>
        entity === ModAuditLog ? auditLogs : reports,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Appeal), useValue: appeals },
        { provide: getRepositoryToken(ModAuditLog), useValue: auditLogs },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        {
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: unknown) => unknown) => cb(manager),
          },
        },
        { provide: AuthService, useValue: { revokeAllForUser } },
      ],
    }).compile();
    service = module.get(ModerationService);
  });

  interface UserPatch {
    status: UserStatus;
    suspendedUntil: Date | null;
  }
  type UpdateCall = [unknown, { id: string }, UserPatch];

  /** `manager.update(User, ...)` calls — i.e. actual account enforcement. */
  const userUpdates = (): UpdateCall[] =>
    (managerUpdate.mock.calls as UpdateCall[]).filter(
      ([entity]) => entity === User,
    );

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
      // Was written against a `Post` report, which now correctly rejects a
      // suspend (you cannot suspend a post). Retargeted at a member report so
      // it still tests what it means to test: that `duration` reaches the log.
      reports.findOne.mockResolvedValue(
        baseReport({
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      );
      profiles.findOne.mockResolvedValue({
        userId: 'user-1',
        slug: 'reported-member',
      });

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

  /**
   * `suspend` and `ban` used to do nothing to the reported member: they closed
   * the report, wrote a convincing audit row, and left the account fully
   * active. Any moderator who banned someone believed it took effect; it did
   * not. The assertions on `users.status` below are the point of this block.
   */
  describe('enforcement against the reported member', () => {
    const memberReport = () =>
      baseReport({
        subjectType: ReportSubjectType.Member,
        subjectId: 'reported-member',
      });

    beforeEach(() => {
      reports.findOne.mockResolvedValue(memberReport());
      profiles.findOne.mockResolvedValue({
        userId: 'user-1',
        slug: 'reported-member',
      });
    });

    it('suspend sets the member suspended with an expiry from the duration', async () => {
      await service.actOnReport('report-1', 'actor-1', {
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Seven days.',
        duration: '7d',
      });

      const [[, where, patch]] = userUpdates();
      expect(where).toEqual({ id: 'user-1' });
      expect(patch.status).toBe(UserStatus.Suspended);
      expect(patch.suspendedUntil).toBeInstanceOf(Date);
      const days =
        ((patch.suspendedUntil as Date).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it('ban suspends permanently — no expiry', async () => {
      await service.actOnReport('report-1', 'actor-1', {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      const [[, , patch]] = userUpdates();
      expect(patch).toEqual({
        status: UserStatus.Suspended,
        suspendedUntil: null,
      });
    });

    it('revokes the suspended member’s live sessions', async () => {
      await service.actOnReport('report-1', 'actor-1', {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      expect(revokeAllForUser).toHaveBeenCalledWith('user-1');
    });

    it('keeps an open deactivation row’s previousStatus in step', async () => {
      await service.actOnReport('report-1', 'actor-1', {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      // Otherwise the member deactivates, signs back in, is restored to
      // `active`, and the ban is laundered away in one click.
      const call = (managerUpdate.mock.calls as UpdateCall[]).find(
        ([entity]) => entity !== User,
      );
      expect(call?.[2]).toEqual({ previousStatus: UserStatus.Suspended });
    });

    it('rejects a suspension with no duration rather than making it permanent', async () => {
      await expect(
        service.actOnReport('report-1', 'actor-1', {
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'n',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userUpdates()).toHaveLength(0);
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it('rejects a malformed duration', async () => {
      await expect(
        service.actOnReport('report-1', 'actor-1', {
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'n',
          duration: 'forever',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userUpdates()).toHaveLength(0);
    });

    it('rejects a ban carrying a duration', async () => {
      await expect(
        service.actOnReport('report-1', 'actor-1', {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'n',
          duration: '7d',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rejects suspend on a non-member report instead of silently no-op-ing', async () => {
      reports.findOne.mockResolvedValue(baseReport()); // subjectType: Post

      await expect(
        service.actOnReport('report-1', 'actor-1', {
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'n',
          duration: '7d',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(userUpdates()).toHaveLength(0);
    });

    it('rejects suspend when the member cannot be resolved to an account', async () => {
      profiles.findOne.mockResolvedValue(null);

      await expect(
        service.actOnReport('report-1', 'actor-1', {
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'n',
          duration: '7d',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    // Guards the other direction: these must NOT touch the account.
    it.each(['dismiss', 'warn', 'escalate', 'hide_content', 'remove_content'])(
      '%s never touches users.status',
      async (action) => {
        await service.actOnReport('report-1', 'actor-1', {
          action,
          reasonCode: 'harassment',
          note: 'n',
        } as never);

        expect(userUpdates()).toHaveLength(0);
        expect(revokeAllForUser).not.toHaveBeenCalled();
      },
    );

    it('restrict remains unenforced — a known gap, asserted so it is not mistaken for done', async () => {
      await service.actOnReport('report-1', 'actor-1', {
        action: 'restrict',
        reasonCode: 'harassment',
        note: 'n',
        duration: '7d',
      });

      expect(userUpdates()).toHaveLength(0);
    });

    it('preserves a member-initiated deactivation rather than overwriting it', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        status: UserStatus.Deactivated,
      });

      await service.actOnReport('report-1', 'actor-1', {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      // `status` is untouched — they asked to be hidden — but the suspension is
      // still recorded, so reactivating brings them back suspended.
      const [[, , patch]] = userUpdates();
      expect(patch).not.toHaveProperty('status');
      expect(patch.suspendedUntil).toBeNull();
      const deactivationCall = (managerUpdate.mock.calls as UpdateCall[]).find(
        ([entity]) => entity !== User,
      );
      expect(deactivationCall?.[2]).toEqual({
        previousStatus: UserStatus.Suspended,
      });
    });

    it('bulk suspend fails the whole batch when one subject is unenforceable', async () => {
      reports.find.mockResolvedValue([
        memberReport(),
        baseReport({ id: 'report-2' }), // a Post — unenforceable
      ]);

      await expect(
        service.bulkActOnReports('actor-1', {
          ids: ['report-1', 'report-2'],
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'n',
          duration: '7d',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });
  });

  describe('liftSuspension', () => {
    it('404s an unknown user', async () => {
      users.findOne.mockResolvedValue(null);
      await expect(
        service.liftSuspension('nope', 'actor-1', {
          reasonCode: 'harassment',
          note: 'n',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('restores a suspended member to active', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        status: UserStatus.Suspended,
      });

      const res = await service.liftSuspension('user-1', 'actor-1', {
        reasonCode: 'harassment',
        note: 'Lifted on review.',
      });

      expect(res).toEqual({ userId: 'user-1', status: UserStatus.Active });
      const [[, , patch]] = userUpdates();
      expect(patch).toEqual({
        status: UserStatus.Active,
        suspendedUntil: null,
      });
    });

    it('writes an audit row with a null reportId when none is given', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        status: UserStatus.Suspended,
      });

      await service.liftSuspension('user-1', 'actor-1', {
        reasonCode: 'harassment',
        note: 'n',
      });

      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: null,
          action: 'suspension_lifted',
        }),
      );
    });

    it('is idempotent for a member who is not suspended', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        status: UserStatus.Active,
      });

      const res = await service.liftSuspension('user-1', 'actor-1', {
        reasonCode: 'harassment',
        note: 'n',
      });

      expect(res.status).toBe(UserStatus.Active);
      expect(userUpdates()).toHaveLength(0);
      expect(auditLogs.save).not.toHaveBeenCalled();
    });
  });
});
