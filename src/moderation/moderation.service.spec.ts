import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { AuthService } from '../auth/auth.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Listing } from '../listings/entities/listing.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole, UserStatus } from '../users/entities/user.entity';
import { Appeal, AppealStatus } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { ModAuditService } from './mod-audit.service';
import { ModerationService } from './moderation.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { NotificationsService } from '../notifications/notifications.service';
import { NotificationType } from '../notifications/entities/notification.entity';

// Chainable query-builder stub whose terminal method resolves to a
// configurable row list (mirrors `partners.service.spec.ts`'s `qbStub`,
// adapted to `cursorPaginate`'s `getMany()` terminal call).
function qbStub(rows: Report[] = []) {
  const qb: Record<string, jest.Mock> = {};
  for (const m of [
    'andWhere',
    'orderBy',
    'addOrderBy',
    'take',
    'select',
    'addSelect',
    'where',
    'groupBy',
  ]) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getMany = jest.fn().mockResolvedValue(rows);
  qb.getRawMany = jest.fn().mockResolvedValue([]);
  return qb;
}

// Chainable stub for `Repository<User>.createQueryBuilder(...)` — the email
// fallback path in `ModAuditService.nameForUserId`/`namesForUserIds`
// (`addSelect('user.email').where(...).getOne()/.getMany()`).
function userQbStub() {
  const qb: Record<string, jest.Mock> = {};
  for (const m of ['addSelect', 'where']) {
    qb[m] = jest.fn().mockReturnValue(qb);
  }
  qb.getOne = jest.fn().mockResolvedValue(null);
  qb.getMany = jest.fn().mockResolvedValue([]);
  return qb;
}

/**
 * `expect.any`/`expect.stringContaining` are typed to return `any` in
 * @types/jest, which poisons the object-literal position they sit in with
 * `no-unsafe-assignment`. These narrow the return type to what the field
 * actually is without changing what runs — still `expect.any`/
 * `expect.stringContaining` underneath.
 */
function matchAnyString(): string {
  return expect.any(String) as string;
}
function matchStringContaining(substring: string): string {
  return expect.stringContaining(substring) as string;
}

/** `notificationsCreate.mock.calls[n]` — the real `create(...)` arg tuple. */
type NotificationsCreateArgs = Parameters<NotificationsService['create']>;
type NotificationsCreateMock = jest.Mock<
  ReturnType<NotificationsService['create']>,
  NotificationsCreateArgs
>;

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
  assignedModeratorId: null,
  assignedAt: null,
  resolvedAt: null,
  resolutionActorId: null,
  resolutionAction: null,
  resolutionDuration: null,
  resolutionNote: null,
  resolutionNotified: null,
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
  let users: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let profiles: { findOne: jest.Mock; find: jest.Mock };
  let revokeAllForUser: jest.Mock;
  let notificationsCreate: NotificationsCreateMock;
  let applyContentAction: jest.Mock;
  let revertContent: jest.Mock;
  let managerUpdate: jest.Mock;
  let communityMembership: {
    isOwnerOrMod: jest.Mock;
    communityIdForPost: jest.Mock;
    communityIdForReply: jest.Mock;
    authorIdForPost: jest.Mock;
    authorIdForReply: jest.Mock;
  };

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
    users = {
      findOne: jest.fn().mockResolvedValue(null),
      createQueryBuilder: jest.fn(() => userQbStub()),
    };
    profiles = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
    };
    revokeAllForUser = jest.fn().mockResolvedValue(undefined);
    notificationsCreate = jest
      .fn<ReturnType<NotificationsService['create']>, NotificationsCreateArgs>()
      .mockResolvedValue(null);
    applyContentAction = jest.fn().mockResolvedValue(undefined);
    // An OVERTURNED appeal now undoes the original takedown (BE-COM-08).
    revertContent = jest.fn().mockResolvedValue(undefined);
    managerUpdate = jest.fn().mockResolvedValue({ affected: 1 });
    // Defaults to "no community, not staff" so every pre-existing test below
    // (all acting as a platform Moderator/Admin) never touches this path, and
    // any test that *does* reach the carve-out fails closed unless it
    // explicitly opts in.
    communityMembership = {
      isOwnerOrMod: jest.fn().mockResolvedValue(false),
      communityIdForPost: jest.fn().mockResolvedValue(null),
      communityIdForReply: jest.fn().mockResolvedValue(null),
      // The dismiss carve-out also refuses a community mod acting on their OWN
      // post/reply, so the author of the reported subject is resolved too.
      // Defaults to "someone else wrote it".
      authorIdForPost: jest.fn().mockResolvedValue('author-1'),
      authorIdForReply: jest.fn().mockResolvedValue('author-1'),
    };

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
      findOne: (entity: unknown, opts: unknown): Promise<unknown> => {
        if (entity === User) return users.findOne(opts) as Promise<unknown>;
        // `revertOriginalAction` resolves the appealed action through the
        // manager, so ModAuditLog reads must not fall through to the reports
        // stub.
        if (entity === ModAuditLog)
          return auditLogs.findOne(opts) as Promise<unknown>;
        return reports.findOne(opts) as Promise<unknown>;
      },
      getRepository: (entity: unknown) =>
        entity === ModAuditLog ? auditLogs : reports,
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        ModAuditService,
        AccountEnforcementService,
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(Appeal), useValue: appeals },
        { provide: getRepositoryToken(ModAuditLog), useValue: auditLogs },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Profile), useValue: profiles },
        // Item #13: a `listing`-subject report's detail surfaces the live
        // listing's pasted evidence. A bare findOne mock suffices.
        {
          provide: getRepositoryToken(Listing),
          useValue: { findOne: jest.fn().mockResolvedValue(null) },
        },
        {
          provide: DataSource,
          useValue: {
            transaction: (cb: (m: unknown) => unknown) => cb(manager),
          },
        },
        { provide: AuthService, useValue: { revokeAllForUser } },
        {
          provide: ContentModerationService,
          useValue: { applyAction: applyContentAction, revert: revertContent },
        },
        {
          provide: NotificationsService,
          useValue: { create: notificationsCreate },
        },
        {
          provide: CommunityMembershipService,
          useValue: communityMembership,
        },
      ],
    }).compile();
    service = module.get(ModerationService);
  });

  interface UserPatch {
    status: UserStatus;
    suspendedUntil: Date | null;
    restricted?: boolean;
    restrictedUntil?: Date | null;
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

      expect(page.data).toEqual([
        expect.objectContaining({
          id: 'report-1',
          severity: ReportSeverity.High,
          reasonCode: 'harassment',
          status: ReportStatus.Open,
        }),
      ]);
      expect(page.data[0]!.reporter).toEqual({
        anonymous: false,
        id: 'reporter-1',
        name: 'Member',
        priorReports: 0,
        priorDismissed: 0,
      });
      expect(page.data[0]!.reported).toEqual({
        id: 'post-1',
        handle: 'post-1',
        priorReports: 0,
      });
      expect(page.data[0]).not.toHaveProperty('detail');
      expect(page.counts).toEqual({ open: 3, resolved: 5, appeals: 2 });
      expect(page.pageInfo).toEqual({ nextCursor: null, hasMore: false });
    });

    it('resolves a non-anonymous reporter name from their profile', async () => {
      const qb = qbStub([baseReport()]);
      reports.createQueryBuilder.mockReturnValue(qb);
      // `list` batches reporter-name resolution through `namesForUserIds`
      // (`profiles.find` by `In([...])`), not a per-row `profiles.findOne`.
      profiles.find.mockResolvedValueOnce([
        { userId: 'reporter-1', firstName: 'Ada', lastName: 'Lovelace' },
      ]);

      const page = await service.list({});
      expect(page.data[0]!.reporter).toEqual({
        anonymous: false,
        id: 'reporter-1',
        name: 'Ada Lovelace',
        priorReports: 0,
        priorDismissed: 0,
      });
    });

    it("surfaces a reporter's prior resolved-report history, excluding an already-resolved current report", async () => {
      const qb = qbStub([
        baseReport({
          status: ReportStatus.Resolved,
          resolvedAt: new Date('2026-01-03T00:00:00.000Z'),
          resolutionAction: 'dismiss',
        }),
      ]);
      reports.createQueryBuilder.mockReturnValue(qb);
      // Two resolved reports total for this reporter across the page's
      // batched query: the current row (dismissed) plus one prior warn.
      qb.getRawMany = jest
        .fn()
        .mockResolvedValue([
          { reporterId: 'reporter-1', total: '2', dismissed: '1' },
        ]);

      const page = await service.list({});
      expect(page.data[0]!.reporter).toEqual({
        anonymous: false,
        id: 'reporter-1',
        name: 'Member',
        // The current (already-resolved, dismissed) report is subtracted
        // from both totals so it never counts against its own reporter.
        priorReports: 1,
        priorDismissed: 0,
      });
    });

    it('shields an anonymous reporter', async () => {
      const qb = qbStub([baseReport({ anonymous: true })]);
      reports.createQueryBuilder.mockReturnValue(qb);

      const page = await service.list({});
      expect(page.data[0]!.reporter).toEqual({ anonymous: true });
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
      expect(page.data[0]!.community).toBe('my-community');
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
        service.actOnReport('nope', 'actor-1', UserRole.Moderator, {
          action: 'dismiss',
          reasonCode: 'spam',
          note: 'Not a violation.',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('escalate moves the report to escalated', async () => {
      reports.findOne.mockResolvedValue(baseReport());

      const res = await service.actOnReport(
        'report-1',
        'actor-1',
        UserRole.Moderator,
        {
          action: 'escalate',
          reasonCode: 'hate_speech',
          note: 'Needs senior review.',
        },
      );

      expect(res.status).toBe(ReportStatus.Escalated);
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportStatus.Escalated }),
      );
    });

    it('every other action resolves the report and does not include detail', async () => {
      reports.findOne.mockResolvedValue(baseReport());

      const res = await service.actOnReport(
        'report-1',
        'actor-1',
        UserRole.Moderator,
        {
          action: 'remove_content',
          reasonCode: 'hate_speech',
          note: 'Removed the post.',
          duration: undefined,
        },
      );

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
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Active,
      });

      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Suspended for a week.',
        duration: '7d',
      });

      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({ duration: '7d' }),
      );
    });

    // The community-owner/mod dismiss carve-out: `PATCH /mod/reports/:id`
    // now admits any active member through the route guard, so
    // `ModerationService.assertCanActOnReport` is the actual authorization —
    // platform Moderator/Admin unchanged, OR a community owner/mod
    // `dismiss`-ing a report on a post/reply in the community they moderate.
    // BE-COM-03: reports now have a real state machine. `open` and `escalated`
    // are actionable, `resolved` is terminal, and the transition is CLAIMED
    // with a conditional `UPDATE ... WHERE status = <expected>` inside the
    // transaction before anything consequential runs. Nothing used to read
    // `report.status` here at all.
    describe('report state machine', () => {
      it('409s a second action on an already-resolved report', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({ status: ReportStatus.Resolved }),
        );

        await expect(
          service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
            action: 'suspend',
            reasonCode: 'harassment',
            note: 'Again.',
            duration: '7d',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        // Acting twice would re-run enforcement, overwrite the recorded
        // resolution with a different actor, and re-notify the reporter.
        expect(managerUpdate).not.toHaveBeenCalled();
        expect(reports.save).not.toHaveBeenCalled();
        expect(auditLogs.save).not.toHaveBeenCalled();
        expect(notificationsCreate).not.toHaveBeenCalled();
      });

      it('claims the transition with a conditional UPDATE before enforcing', async () => {
        reports.findOne.mockResolvedValue(baseReport());

        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'dismiss',
          reasonCode: 'spam',
          note: 'Not a violation.',
        });

        expect(managerUpdate).toHaveBeenNthCalledWith(
          1,
          Report,
          { id: 'report-1', status: ReportStatus.Open },
          { status: ReportStatus.Resolved },
        );
      });

      it('still lets an escalated report be decided', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({ status: ReportStatus.Escalated }),
        );

        const res = await service.actOnReport(
          'report-1',
          'actor-1',
          UserRole.Moderator,
          { action: 'dismiss', reasonCode: 'spam', note: 'Closed.' },
        );

        expect(res.status).toBe(ReportStatus.Resolved);
        expect(managerUpdate).toHaveBeenNthCalledWith(
          1,
          Report,
          { id: 'report-1', status: ReportStatus.Escalated },
          { status: ReportStatus.Resolved },
        );
      });

      it('409s and enforces nothing when a concurrent moderator won the claim', async () => {
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
        users.findOne.mockResolvedValue({
          id: 'user-1',
          role: UserRole.Member,
          status: UserStatus.Active,
        });
        // The losing side of the race: the row was already moved on.
        managerUpdate.mockResolvedValue({ affected: 0 });

        await expect(
          service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
            action: 'ban',
            reasonCode: 'harassment',
            note: 'Out.',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(userUpdates()).toHaveLength(0);
        expect(revokeAllForUser).not.toHaveBeenCalled();
        expect(auditLogs.save).not.toHaveBeenCalled();
      });
    });

    describe('authorization', () => {
      it('lets a platform Moderator/Admin act on any report without consulting community roster at all', async () => {
        reports.findOne.mockResolvedValue(baseReport());

        const res = await service.actOnReport(
          'report-1',
          'admin-1',
          UserRole.Admin,
          { action: 'dismiss', reasonCode: 'spam', note: 'Not a violation.' },
        );

        expect(res.status).toBe(ReportStatus.Resolved);
        // The platform-role path short-circuits before any community lookup.
        expect(communityMembership.communityIdForPost).not.toHaveBeenCalled();
        expect(communityMembership.isOwnerOrMod).not.toHaveBeenCalled();
        // A genuine platform Moderator/Admin still gets the fully resolved
        // report back — this fix must not touch that path.
        expect(res.reporter).toEqual({
          anonymous: false,
          id: 'reporter-1',
          name: 'Member',
          priorReports: 0,
          priorDismissed: 0,
        });
        expect(res.reported).toEqual({
          id: 'post-1',
          handle: 'post-1',
          priorReports: 0,
        });
      });

      it('lets a community owner/mod dismiss a report on a post/reply in the community they moderate, but withholds the report/reporter detail from the response', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
            assignedModeratorId: 'other-moderator-1',
          }),
        );
        communityMembership.communityIdForPost.mockResolvedValue('community-1');
        communityMembership.isOwnerOrMod.mockResolvedValue(true);

        const res = await service.actOnReport(
          'report-1',
          'community-mod-1',
          UserRole.Member,
          { action: 'dismiss', reasonCode: 'spam', note: 'Not a violation.' },
        );

        expect(res.status).toBe(ReportStatus.Resolved);
        expect(communityMembership.communityIdForPost).toHaveBeenCalledWith(
          'post-1',
        );
        expect(communityMembership.isOwnerOrMod).toHaveBeenCalledWith(
          'community-1',
          'community-mod-1',
        );
        // This carve-out grants no report *visibility* (see
        // `assertCanActOnReport`'s doc comment): the reporter's real name and
        // platform-wide prior-report history must not reach a community mod
        // who only authorized through the dismiss carve-out, and neither
        // should which platform moderator (if any) is assigned to the report.
        expect(res.reporter).toEqual({ anonymous: true });
        expect(res.reported).toEqual({
          id: 'post-1',
          handle: 'post-1',
          priorReports: 0,
        });
        expect(res.assignedModeratorId).toBeNull();
        expect(res).not.toHaveProperty('assignedModeratorName');
        expect(res).not.toHaveProperty('detail');
      });

      it('forbids a community owner/mod from dismissing a report in a community they do not moderate', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
          }),
        );
        communityMembership.communityIdForPost.mockResolvedValue(
          'someone-elses-community',
        );
        // Actor is on staff somewhere, just not on THIS post's community.
        communityMembership.isOwnerOrMod.mockResolvedValue(false);

        await expect(
          service.actOnReport(
            'report-1',
            'other-community-mod-1',
            UserRole.Member,
            {
              action: 'dismiss',
              reasonCode: 'spam',
              note: 'Not a violation.',
            },
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(reports.save).not.toHaveBeenCalled();
      });

      it('forbids a community owner/mod from dismissing a non-community report (e.g. a member report)', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Member,
            subjectId: 'reported-member',
          }),
        );

        await expect(
          service.actOnReport('report-1', 'community-mod-1', UserRole.Member, {
            action: 'dismiss',
            reasonCode: 'harassment',
            note: 'Not a violation.',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        // A `member`-subject report never resolves to a community — the
        // carve-out's resolver isn't even reached for post/reply lookups.
        expect(communityMembership.communityIdForPost).not.toHaveBeenCalled();
        expect(communityMembership.communityIdForReply).not.toHaveBeenCalled();
        expect(reports.save).not.toHaveBeenCalled();
      });

      // `isOwnerOrMod` says the actor moderates the community, not that they
      // are impartial about THIS report. Without this they could close the
      // report about their own post in one call, platform-wide.
      it('forbids a community owner/mod from dismissing a report about their own post', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
          }),
        );
        communityMembership.communityIdForPost.mockResolvedValue('community-1');
        communityMembership.isOwnerOrMod.mockResolvedValue(true);
        communityMembership.authorIdForPost.mockResolvedValue(
          'community-mod-1',
        );

        await expect(
          service.actOnReport('report-1', 'community-mod-1', UserRole.Member, {
            action: 'dismiss',
            reasonCode: 'spam',
            note: 'Nothing to see here.',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(reports.save).not.toHaveBeenCalled();
      });

      // `escalated` means "send this up" — letting the community it came from
      // close it undoes a platform moderator's decision.
      it('forbids a community owner/mod from dismissing a report that is no longer open', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
            status: ReportStatus.Escalated,
          }),
        );
        communityMembership.communityIdForPost.mockResolvedValue('community-1');
        communityMembership.isOwnerOrMod.mockResolvedValue(true);

        await expect(
          service.actOnReport('report-1', 'community-mod-1', UserRole.Member, {
            action: 'dismiss',
            reasonCode: 'spam',
            note: 'Not a violation.',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(reports.save).not.toHaveBeenCalled();
      });

      it('forbids a community owner/mod from taking any action other than dismiss, even within their own community', async () => {
        reports.findOne.mockResolvedValue(
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
          }),
        );
        communityMembership.communityIdForPost.mockResolvedValue('community-1');
        communityMembership.isOwnerOrMod.mockResolvedValue(true);

        await expect(
          service.actOnReport('report-1', 'community-mod-1', UserRole.Member, {
            action: 'remove_content',
            reasonCode: 'hate_speech',
            note: 'Removed the post.',
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(reports.save).not.toHaveBeenCalled();
      });
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
      // Continue-on-error (P0-16): the response reports both halves of the
      // batch, so an empty run is `{ updated: [], failed: [] }`.
      expect(res).toEqual({ updated: [], failed: [] });
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
      expect(res.failed).toEqual([]);
      // One transaction (and so one save) PER report, rather than a single
      // batched `save([...])`: each report is applied on its own so one
      // failure can no longer roll the whole selection back.
      expect(reports.save).toHaveBeenCalledTimes(2);
      expect(reports.save).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          id: 'report-1',
          status: ReportStatus.Resolved,
        }),
      );
      expect(reports.save).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          id: 'report-2',
          status: ReportStatus.Resolved,
        }),
      );
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
      expect(reports.save).toHaveBeenCalledWith(
        expect.objectContaining({ status: ReportStatus.Escalated }),
      );
    });

    // Same state machine as the single-report path: a resolved report swept
    // into a bulk selection must not be silently re-enforced against.
    it('lands an already-resolved report in failed instead of re-actioning it', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-1' }),
        baseReport({ id: 'report-2', status: ReportStatus.Resolved }),
      ]);

      const res = await service.bulkActOnReports('actor-1', {
        ids: ['report-1', 'report-2'],
        action: 'dismiss',
        reasonCode: 'spam',
      });

      expect(res.updated).toEqual(['report-1']);
      expect(res.failed).toEqual([
        { id: 'report-2', reason: matchStringContaining('already') },
      ]);
      expect(reports.save).toHaveBeenCalledTimes(1);
      expect(auditLogs.save).toHaveBeenCalledTimes(1);
    });

    it('notifies each sanctioned member — one row per report', async () => {
      reports.find.mockResolvedValue([
        baseReport({
          id: 'report-1',
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
        baseReport({
          id: 'report-2',
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      ]);
      profiles.findOne.mockResolvedValue({
        userId: 'user-1',
        slug: 'reported-member',
      });
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Active,
      });

      await service.bulkActOnReports('actor-1', {
        ids: ['report-1', 'report-2'],
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Bulk suspend.',
        duration: '7d',
      });

      const memberCalls = notificationsCreate.mock.calls.filter(
        (args) => args[1] === NotificationType.ModerationOutcome,
      );
      expect(memberCalls).toHaveLength(2);
      expect(memberCalls[0]).toEqual([
        'user-1',
        NotificationType.ModerationOutcome,
        expect.objectContaining({
          source: 'moderation',
          action: 'suspend',
          expiresAt: matchAnyString(),
        }),
      ]);
    });

    // Closing the loop on a report. Batch-actioning a queue is how most
    // reports are actually closed, and this path used to notify the sanctioned
    // member and nobody else, so most reporters heard nothing ever.
    it('tells every reporter their report reached an outcome', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-1', reporterId: 'reporter-1' }),
        baseReport({ id: 'report-2', reporterId: 'reporter-2' }),
      ]);

      await service.bulkActOnReports('actor-1', {
        ids: ['report-1', 'report-2'],
        action: 'dismiss',
        reasonCode: 'spam',
        note: 'Internal reasoning the reporter must never see.',
      });

      const reporterCalls = notificationsCreate.mock.calls.filter(
        (args) => args[1] === NotificationType.ReportResolved,
      );
      expect(reporterCalls).toHaveLength(2);
      expect(reporterCalls[0]).toEqual([
        'reporter-1',
        NotificationType.ReportResolved,
        {
          source: 'report',
          reportId: 'report-1',
          reference: matchAnyString(),
          subjectType: ReportSubjectType.Post,
          outcome: ReportStatus.Resolved,
        },
      ]);
    });

    // The boundary that matters more than the notification itself.
    it('never discloses the moderator, the action, the duration or the note to the reporter', async () => {
      reports.find.mockResolvedValue([baseReport({ id: 'report-1' })]);

      await service.bulkActOnReports('actor-1', {
        ids: ['report-1'],
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Third strike, prior warnings on file.',
        duration: '7d',
      });

      const reporterCall = notificationsCreate.mock.calls.find(
        (args) => args[1] === NotificationType.ReportResolved,
      );
      expect(reporterCall).toBeDefined();
      const payload = JSON.stringify(reporterCall?.[2] ?? {});
      expect(payload).not.toContain('actor-1');
      expect(payload).not.toContain('suspend');
      expect(payload).not.toContain('7d');
      expect(payload).not.toContain('Third strike');
      // And no third argument at all, so the block/mute filter and the
      // preference gate are both bypassed: this is the platform's word.
      expect(reporterCall?.[3]).toBeUndefined();
    });

    it('does not notify a reporter who is the acting moderator', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-1', reporterId: 'actor-1' }),
      ]);

      await service.bulkActOnReports('actor-1', {
        ids: ['report-1'],
        action: 'dismiss',
        reasonCode: 'spam',
      });

      expect(
        notificationsCreate.mock.calls.filter(
          (args) => args[1] === NotificationType.ReportResolved,
        ),
      ).toHaveLength(0);
    });

    it('does not notify an anonymous filing with no reporter to reach', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-1', reporterId: null }),
      ]);

      await service.bulkActOnReports('actor-1', {
        ids: ['report-1'],
        action: 'dismiss',
        reasonCode: 'spam',
      });

      expect(
        notificationsCreate.mock.calls.filter(
          (args) => args[1] === NotificationType.ReportResolved,
        ),
      ).toHaveLength(0);
    });
  });

  /**
   * COM-5: assignment is a CLAIM, not a free-for-all. It used to write
   * `assignedModeratorId = assign ? actorId : null` unconditionally, so any
   * moderator could take a report off a colleague mid-investigation or release
   * anyone's. The write is now a conditional `UPDATE ... WHERE
   * assigned_moderator_id IS NOT DISTINCT FROM <expected>`.
   */
  describe('setAssignment', () => {
    // `.createQueryBuilder().update().set().where().andWhere().execute()`.
    function updateQbStub(affected = 1) {
      const qb: Record<string, jest.Mock> = {};
      for (const method of ['update', 'set', 'where', 'andWhere']) {
        qb[method] = jest.fn().mockReturnValue(qb);
      }
      qb.execute = jest.fn().mockResolvedValue({ affected });
      return qb;
    }

    it('claims an unassigned report', async () => {
      reports.findOne.mockResolvedValue(baseReport());
      const qb = updateQbStub();
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.setAssignment(
        'report-1',
        'moderator-1',
        UserRole.Moderator,
        true,
      );

      expect(qb.set).toHaveBeenCalledWith(
        expect.objectContaining({ assignedModeratorId: 'moderator-1' }),
      );
      // NULL is the expected value on an unclaimed report, and `NULL = NULL` is
      // NULL rather than true — hence `IS NOT DISTINCT FROM`.
      expect(qb.andWhere).toHaveBeenCalledWith(
        'assigned_moderator_id IS NOT DISTINCT FROM :expected',
        { expected: null },
      );
    });

    it('is idempotent when re-claiming a report you already hold', async () => {
      reports.findOne.mockResolvedValue(
        baseReport({ assignedModeratorId: 'moderator-1' }),
      );

      await expect(
        service.setAssignment(
          'report-1',
          'moderator-1',
          UserRole.Moderator,
          true,
        ),
      ).resolves.toBeDefined();
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('409s a moderator taking a report already assigned to someone else', async () => {
      reports.findOne.mockResolvedValue(
        baseReport({ assignedModeratorId: 'other-moderator' }),
      );

      await expect(
        service.setAssignment(
          'report-1',
          'moderator-1',
          UserRole.Moderator,
          true,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('lets an Admin take over another moderator’s report', async () => {
      reports.findOne.mockResolvedValue(
        baseReport({ assignedModeratorId: 'other-moderator' }),
      );
      const qb = updateQbStub();
      reports.createQueryBuilder.mockReturnValue(qb);

      await expect(
        service.setAssignment('report-1', 'admin-1', UserRole.Admin, true),
      ).resolves.toBeDefined();
      expect(qb.andWhere).toHaveBeenCalledWith(
        'assigned_moderator_id IS NOT DISTINCT FROM :expected',
        { expected: 'other-moderator' },
      );
    });

    it('403s a moderator releasing someone else’s report', async () => {
      reports.findOne.mockResolvedValue(
        baseReport({ assignedModeratorId: 'other-moderator' }),
      );

      await expect(
        service.setAssignment(
          'report-1',
          'moderator-1',
          UserRole.Moderator,
          false,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
    });

    it('409s when the assignment changed under the claim', async () => {
      reports.findOne.mockResolvedValue(baseReport());
      reports.createQueryBuilder.mockReturnValue(updateQbStub(0));

      await expect(
        service.setAssignment(
          'report-1',
          'moderator-1',
          UserRole.Moderator,
          true,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
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
      // `auditTrail` now resolves actor names in one batched `namesForUserIds`
      // (`profiles.find` by `In([...])`), not a per-row `profiles.findOne`.
      profiles.find.mockResolvedValueOnce([
        { userId: 'actor-1', firstName: 'Mod', lastName: 'Erator' },
      ]);

      const rows = await service.auditTrail('report-1');

      expect(auditLogs.find).toHaveBeenCalledWith({
        where: { reportId: 'report-1' },
        order: { createdAt: 'ASC' },
        take: 20,
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
        take: 20,
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

    // BE-COM-08: an overturn used to flip the appeal's status (and, for a
    // suspension, restore the account) and nothing else — a member whose post
    // was hidden and who WON their appeal still had the post hidden, and admin
    // saw "overturned" while nothing had changed for them.
    describe('an overturn reverts the original action', () => {
      it('restores hidden/removed content and logs content_restored', async () => {
        appeals.findOne.mockResolvedValue(baseAppeal());
        auditLogs.findOne.mockResolvedValue({
          id: 'log-1',
          reportId: 'report-1',
          actorId: 'actor-2',
          action: 'hide_content',
          reasonCode: 'hate_speech',
          note: null,
          duration: null,
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        });
        reports.findOne.mockResolvedValue(baseReport());

        await service.reviewAppeal('appeal-1', 'actor-1', {
          decision: 'overturn',
          note: 'The post was fine.',
        });

        expect(revertContent).toHaveBeenCalledWith(
          expect.anything(),
          ReportSubjectType.Post,
          'post-1',
        );
        expect(auditLogs.save).toHaveBeenCalledWith(
          expect.objectContaining({
            reportId: 'report-1',
            actorId: 'actor-1',
            action: 'content_restored',
          }),
        );
      });

      it('clears the restriction flags and logs restriction_lifted', async () => {
        appeals.findOne.mockResolvedValue(baseAppeal());
        auditLogs.findOne.mockResolvedValue({
          id: 'log-1',
          reportId: 'report-1',
          actorId: 'actor-2',
          action: 'restrict',
          reasonCode: 'harassment',
          note: null,
          duration: '7d',
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        });
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

        await service.reviewAppeal('appeal-1', 'actor-1', {
          decision: 'overturn',
          note: 'Overturned.',
        });

        // `status` is deliberately untouched — a restriction never changed it.
        expect(managerUpdate).toHaveBeenCalledWith(
          User,
          { id: 'user-1' },
          { restricted: false, restrictedUntil: null },
        );
        expect(auditLogs.save).toHaveBeenCalledWith(
          expect.objectContaining({
            actorId: 'actor-1',
            action: 'restriction_lifted',
          }),
        );
      });

      it('leaves the content alone when the appeal is upheld', async () => {
        appeals.findOne.mockResolvedValue(baseAppeal());
        auditLogs.findOne.mockResolvedValue({
          id: 'log-1',
          reportId: 'report-1',
          actorId: 'actor-2',
          action: 'hide_content',
          reasonCode: 'hate_speech',
          note: null,
          duration: null,
          createdAt: new Date('2026-01-01T12:00:00.000Z'),
        });
        reports.findOne.mockResolvedValue(baseReport());

        await service.reviewAppeal('appeal-1', 'actor-1', {
          decision: 'uphold',
          note: 'The original call stands.',
        });

        expect(revertContent).not.toHaveBeenCalled();
      });
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
      // Enforcement now loads the target account and refuses to act on a
      // non-member (staff-guard, a prior security fix), so the resolved user
      // must carry a role for the suspend/ban path to reach the account.
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Active,
      });
    });

    it('suspend sets the member suspended with an expiry from the duration', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Seven days.',
        duration: '7d',
      });

      const [, where, patch] = userUpdates()[0]!;
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
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      const [, , patch] = userUpdates()[0]!;
      expect(patch).toEqual({
        status: UserStatus.Suspended,
        suspendedUntil: null,
      });
    });

    it('revokes the suspended member’s live sessions', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      expect(revokeAllForUser).toHaveBeenCalledWith('user-1');
    });

    // The audit's open gap: a warned/suspended/banned member was told nothing.
    // The reporter got `report_resolved`; the sanctioned member now gets
    // `moderation_outcome` with the reason.
    describe('outcome notification to the sanctioned member', () => {
      // The `moderation_outcome` create call, past the reporter's
      // `report_resolved` create that `actOnReport` also fires.
      const memberCall = () =>
        notificationsCreate.mock.calls.find(
          (args) => args[1] === NotificationType.ModerationOutcome,
        );

      it('warn notifies the warned member with the reason', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'warn',
          reasonCode: 'harassment',
          note: 'Please stop.',
        });

        expect(memberCall()).toEqual([
          'user-1',
          NotificationType.ModerationOutcome,
          expect.objectContaining({
            source: 'moderation',
            action: 'warn',
            reasonCode: 'harassment',
            note: 'Please stop.',
          }),
        ]);
      });

      it('suspend notifies the member and carries the expiry', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'suspend',
          reasonCode: 'harassment',
          note: 'Seven days.',
          duration: '7d',
        });

        const call = memberCall();
        expect(call?.[0]).toBe('user-1');
        expect(call?.[2]).toEqual(
          expect.objectContaining({
            action: 'suspend',
            expiresAt: matchAnyString(),
          }),
        );
      });

      it('ban notifies the member with no expiry', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        });

        const call = memberCall();
        expect(call?.[0]).toBe('user-1');
        expect(call?.[2]).toMatchObject({ action: 'ban' });
        expect(call?.[2]).not.toHaveProperty('expiresAt');
      });

      it('is delivered with no actor — bypassing the block/mute + mute gate', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'warn',
          reasonCode: 'harassment',
          note: 'n',
        });

        // `create(userId, type, payload)` — a fourth `actorId` arg would
        // re-enable the block/mute + per-type-mute filter a moderation outcome
        // must always skip.
        expect(memberCall()).toHaveLength(3);
      });

      it.each(['dismiss', 'escalate', 'hide_content', 'remove_content'])(
        '%s does not notify the member (no account-facing outcome)',
        async (action) => {
          await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
            action,
            reasonCode: 'harassment',
            note: 'n',
          } as never);

          expect(memberCall()).toBeUndefined();
        },
      );

      it('restrict notifies the member and carries the expiry', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'restrict',
          reasonCode: 'harassment',
          note: 'Cool it for a week.',
          duration: '7d',
        });

        const call = memberCall();
        expect(call?.[0]).toBe('user-1');
        expect(call?.[2]).toEqual(
          expect.objectContaining({
            action: 'restrict',
            expiresAt: matchAnyString(),
          }),
        );
      });

      it('never notifies a moderator acting on their own report', async () => {
        // The reported member IS the actor (edge case) — no self-notification.
        await service.actOnReport('report-1', 'user-1', UserRole.Moderator, {
          action: 'warn',
          reasonCode: 'harassment',
          note: 'n',
        });

        expect(memberCall()).toBeUndefined();
      });
    });

    it('keeps an open deactivation row’s previousStatus in step', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      // Otherwise the member deactivates, signs back in, is restored to
      // `active`, and the ban is laundered away in one click.
      // Matched on `AccountDeactivation` specifically: the transaction now
      // opens with a conditional `manager.update(Report, { id, status }, ...)`
      // claiming the state transition, which is also a non-`User` update and
      // would otherwise be the row this assertion picked up.
      const call = (managerUpdate.mock.calls as UpdateCall[]).find(
        ([entity]) => entity === AccountDeactivation,
      );
      expect(call?.[2]).toEqual({ previousStatus: UserStatus.Suspended });
    });

    // BE-COM-33: the house account carries `role = member` with
    // `is_system = true`, so the staff-role check below does not catch it — a
    // ban resolved from a report against its slug would suspend the platform's
    // own account and revoke its sessions.
    it('refuses to enforce against the system/house account', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Active,
        isSystem: true,
      });

      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(userUpdates()).toHaveLength(0);
      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it('rejects a suspension with no duration rather than making it permanent', async () => {
      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
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
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
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
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
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
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
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
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
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
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action,
          reasonCode: 'harassment',
          note: 'n',
        } as never);

        expect(userUpdates()).toHaveLength(0);
        expect(revokeAllForUser).not.toHaveBeenCalled();
      },
    );

    it('restrict sets the member restricted with an expiry from the duration, leaving status untouched', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'restrict',
        reasonCode: 'harassment',
        note: 'n',
        duration: '7d',
      });

      const [, where, patch] = userUpdates()[0]!;
      expect(where).toEqual({ id: 'user-1' });
      expect(patch).not.toHaveProperty('status');
      expect(patch).not.toHaveProperty('suspendedUntil');
      expect(patch.restricted).toBe(true);
      expect(patch.restrictedUntil).toBeInstanceOf(Date);
      const days =
        ((patch.restrictedUntil as Date).getTime() - Date.now()) /
        (24 * 60 * 60 * 1000);
      expect(days).toBeGreaterThan(6.9);
      expect(days).toBeLessThan(7.1);
    });

    it('restrict without a duration falls back to a default rather than 400ing', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'restrict',
        reasonCode: 'harassment',
        note: 'n',
      });

      const [, , patch] = userUpdates()[0]!;
      expect(patch.restricted).toBe(true);
      expect(patch.restrictedUntil).toBeInstanceOf(Date);
    });

    it('preserves a member-initiated deactivation rather than overwriting it', async () => {
      users.findOne.mockResolvedValue({
        id: 'user-1',
        role: UserRole.Member,
        status: UserStatus.Deactivated,
      });

      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      // `status` is untouched — they asked to be hidden — but the suspension is
      // still recorded, so reactivating brings them back suspended.
      const [, , patch] = userUpdates()[0]!;
      expect(patch).not.toHaveProperty('status');
      expect(patch.suspendedUntil).toBeNull();
      const deactivationCall = (managerUpdate.mock.calls as UpdateCall[]).find(
        ([entity]) => entity === AccountDeactivation,
      );
      expect(deactivationCall?.[2]).toEqual({
        previousStatus: UserStatus.Suspended,
      });
    });

    // Continue-on-error (P0-16): a bulk action used to run in ONE transaction,
    // so a single unenforceable report (a `post` slipped into a suspend
    // selection) rolled back every other report the moderator had picked and
    // told them nothing about which one was at fault. Each report now applies
    // in its own transaction and the unenforceable one is reported per-item.
    it('bulk suspend applies the enforceable reports and reports the rest per item', async () => {
      reports.find.mockResolvedValue([
        memberReport(),
        baseReport({ id: 'report-2' }), // a Post — unenforceable
      ]);

      const res = await service.bulkActOnReports('actor-1', {
        ids: ['report-1', 'report-2'],
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'n',
        duration: '7d',
      });

      expect(res.updated).toEqual(['report-1']);
      expect(res.failed).toEqual([
        {
          id: 'report-2',
          reason: matchStringContaining('post'),
        },
      ]);
      // The report that DID commit still enforces in full — the failed sibling
      // must not suppress it.
      expect(revokeAllForUser).toHaveBeenCalledWith('user-1');
      expect(revokeAllForUser).toHaveBeenCalledTimes(1);
    });

    // The unenforceable report is left exactly as it was: the claiming UPDATE
    // is inside the per-report transaction, so its rollback takes the status
    // change with it rather than leaving a `resolved` report nobody acted on.
    it('does not enforce against anyone for the failed half of the batch', async () => {
      reports.find.mockResolvedValue([
        baseReport({ id: 'report-2' }), // a Post — unenforceable
      ]);

      const res = await service.bulkActOnReports('actor-1', {
        ids: ['report-2'],
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'n',
        duration: '7d',
      });

      expect(res.updated).toEqual([]);
      expect(res.failed).toHaveLength(1);
      expect(userUpdates()).toHaveLength(0);
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
      const [, , patch] = userUpdates()[0]!;
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
