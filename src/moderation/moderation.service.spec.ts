import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AccountDeactivation } from '../account/entities/account-deactivation.entity';
import { AuthService } from '../auth/auth.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ReportSubjectResolverService } from './report-subject-resolver.service';
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
import { BanRatificationService } from './ban-ratification.service';
import { BanRatification } from './entities/ban-ratification.entity';
import { BAN_PENDING_AUDIT_ACTION } from './ban-ratification-window';
import { EventEmitter2 } from '@nestjs/event-emitter';
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
    createQueryBuilder: jest.Mock;
    findOne: jest.Mock;
    find: jest.Mock;
    save: jest.Mock;
    create: jest.Mock;
    count: jest.Mock;
  };
  // TS-11: the appeals queue is keyset-paged now, so its tests read the query
  // builder the same way the reports-queue tests do. One shared instance per
  // test so an assertion can look at what `listAppeals` described.
  let appealsQb: Record<string, jest.Mock>;
  let auditLogs: {
    save: jest.Mock;
    create: jest.Mock;
    find: jest.Mock;
    findOne: jest.Mock;
  };
  let users: { findOne: jest.Mock; createQueryBuilder: jest.Mock };
  // TS-12: the second-moderator hold a permanent ban now opens instead of
  // removing the account outright.
  let banRatifications: {
    findOne: jest.Mock;
    create: jest.Mock;
    save: jest.Mock;
    update: jest.Mock;
  };
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
    slugById: jest.Mock;
    refsByIds: jest.Mock;
  };
  // TS-02/TS-03/TS-14 all read the report's subject through this one service.
  let subjectResolver: { resolve: jest.Mock; resolveMany: jest.Mock };
  // TS-06: the raw `DataSource.query` behind the queue's subject clusters.
  let dataSourceQuery: jest.Mock;

  beforeEach(async () => {
    reports = {
      createQueryBuilder: jest.fn(() => qbStub()),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      save: jest.fn((r: unknown) => Promise.resolve(r)),
      count: jest.fn().mockResolvedValue(0),
    };
    appealsQb = qbStub();
    appeals = {
      createQueryBuilder: jest.fn(() => appealsQb),
      findOne: jest.fn(),
      find: jest.fn().mockResolvedValue([]),
      // `save` echoes the row back with the columns the DATABASE fills in, the
      // way TypeORM's does: `submitAppeal` maps the saved entity straight to
      // `SubmittedAppealDTO`, which reads `id` and `createdAt` off it.
      save: jest.fn((a: object) =>
        Promise.resolve({ id: 'appeal-1', createdAt: new Date(), ...a }),
      ),
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
    // Defaults to "no hold stands yet", so a ban opens a fresh one. `save`
    // echoes the row back with an id, which is what the enforcement result
    // reports as `ratificationId`.
    banRatifications = {
      findOne: jest.fn().mockResolvedValue(null),
      create: jest.fn((values: object) => values),
      save: jest.fn((row: object) =>
        Promise.resolve({ id: 'ratification-1', ...row }),
      ),
      update: jest.fn().mockResolvedValue({ affected: 1 }),
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
      // TS-14: community id -> slug for the queue rows. Defaults to "no such
      // community", so a test only sees a community on a row when it says so.
      slugById: jest.fn().mockResolvedValue(null),
      refsByIds: jest.fn().mockResolvedValue(new Map()),
    };

    dataSourceQuery = jest.fn().mockResolvedValue([]);

    // Defaults to "nothing resolved", so a `warn` or a `suspend` on a content
    // report fails closed in every pre-existing test unless it opts in.
    subjectResolver = {
      resolve: jest.fn().mockResolvedValue({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
      }),
      resolveMany: jest.fn().mockResolvedValue(new Map()),
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
      getRepository: (entity: unknown) => {
        if (entity === ModAuditLog) return auditLogs;
        if (entity === BanRatification) return banRatifications;
        return reports;
      },
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
        // TS-12: `AccountEnforcementService` injects the hold repository so it
        // can write the hold and the interim suspension in one transaction.
        // The hold itself is opened through the transaction's own
        // `getRepository`, so this token only has to exist.
        {
          provide: getRepositoryToken(BanRatification),
          useValue: banRatifications,
        },
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
            // TS-06: `clustersFor` runs one raw grouped aggregate per page.
            // Defaults to "no pile anywhere", so every pre-existing `list`
            // test sees an empty `clusters` array and only a test that opts in
            // sees a cluster.
            query: dataSourceQuery,
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
        {
          provide: ReportSubjectResolverService,
          useValue: subjectResolver,
        },
        // `actOnReport` emits `ACCOUNT_REMOVED` post-commit (TS-05). The spec
        // never imported `EventEmitterModule`, so the token needs a stub or
        // Nest cannot construct the service at all.
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        // TS-12: the second-moderator hold. Defaults to "nothing to withdraw",
        // so every pre-existing appeal test is unaffected.
        {
          provide: BanRatificationService,
          useValue: {
            list: jest.fn().mockResolvedValue([]),
            decide: jest.fn(),
            withdrawPendingHold: jest.fn().mockResolvedValue(false),
            expireDueHolds: jest.fn().mockResolvedValue([]),
          },
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

      /**
       * TS-13: a photograph in a gathering's album is reportable on its own,
       * and a gathering hosted by a community is that community's room. The
       * carve-out's two resolvers used to be `post`/`reply` only, so a photo
       * report was unreachable for the moderators closest to the event.
       *
       * `event_photo` resolves through the shared subject resolver rather than
       * `CommunityMembershipService`, so these tests drive
       * `subjectResolver.resolve` and assert the post/reply lookups are never
       * consulted.
       */
      describe('a gathering photo belongs to the community hosting it (TS-13)', () => {
        // Real uuid shape: `reports.subject_id` is a varchar carrying slugs as
        // well as ids, and the organizer check refuses to compare a non-uuid
        // against a uuid column at all.
        const PHOTO_ID = '11111111-2222-4333-8444-555555555555';

        const photoReport = (overrides: Partial<Report> = {}): Report =>
          baseReport({
            subjectType: ReportSubjectType.EventPhoto,
            subjectId: PHOTO_ID,
            ...overrides,
          });

        /** What the resolver answers for one photo. */
        const resolvedPhoto = (
          overrides: Partial<{
            authorUserId: string | null;
            communityId: string | null;
          }> = {},
        ): void => {
          subjectResolver.resolve.mockResolvedValue({
            authorUserId: 'uploader-1',
            excerpt: '(photo in the album for: Trans swim night) no caption',
            communityId: 'community-1',
            isAuthorAmbiguous: false,
            ...overrides,
          });
        };

        // TS-13 routed the photo report to the community. TS-14 then narrowed
        // what arrives there to ONE action, so this is the test that the
        // routing itself still works: the community is resolved from the
        // gathering, the roster is checked, and the moderator gets a redacted
        // response.
        it('lets a community owner/mod escalate a report about a photo in a gathering their community hosts', async () => {
          reports.findOne.mockResolvedValue(photoReport());
          resolvedPhoto();
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'escalate',
              reasonCode: 'spam',
              note: 'Two of us recognise the uploader, staff should look.',
            },
          );

          expect(res.status).toBe(ReportStatus.Escalated);
          expect(communityMembership.isOwnerOrMod).toHaveBeenCalledWith(
            'community-1',
            'community-mod-1',
          );
          // The community comes from the GATHERING, never from a post/reply
          // lookup and never from the uploader's own memberships.
          expect(communityMembership.communityIdForPost).not.toHaveBeenCalled();
          expect(
            communityMembership.communityIdForReply,
          ).not.toHaveBeenCalled();
          // Still no report visibility: this carve-out redacts its response
          // exactly as the post/reply one does.
          expect(res.reporter).toEqual({ anonymous: true });
        });

        // A gathering with no community is platform-only. Inferring one from
        // the uploader's memberships would hand the photo to a room that had
        // nothing to do with the event.
        it('forbids a community owner/mod on a photo from a gathering with no community', async () => {
          reports.findOne.mockResolvedValue(photoReport());
          resolvedPhoto({ communityId: null });
          // Even a member who moderates somewhere gets nowhere: with no
          // community resolved there is no roster to check them against.
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'dismiss',
                reasonCode: 'spam',
                note: 'Not a violation.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(communityMembership.isOwnerOrMod).not.toHaveBeenCalled();
          expect(reports.save).not.toHaveBeenCalled();
        });

        /**
         * `event_photos.uploader_id` is `ON DELETE SET NULL`
         * (`AddEventPhotoAndFeaturedCommunityForeignKeys1785001300000`), so an
         * uploader who erased their account leaves the photo with no author.
         * The conflict check must then find nobody to match rather than
         * throwing or resolving to the gathering's host, who is a different
         * person on most albums.
         */
        it('degrades to no author when the uploader erased their account, and still lets the community escalate', async () => {
          reports.findOne.mockResolvedValue(photoReport());
          resolvedPhoto({ authorUserId: null });
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'escalate',
              reasonCode: 'harassment',
              note: 'Sending this up.',
            },
          );

          expect(res.status).toBe(ReportStatus.Escalated);
          expect(reports.save).toHaveBeenCalledWith(
            expect.objectContaining({ status: ReportStatus.Escalated }),
          );
        });

        // The same self-dealing the post arm refuses: `isOwnerOrMod` says the
        // actor moderates the room, and says nothing about whether they are
        // impartial about this photo. Since TS-14 the subject refusal lands
        // first and this is doubly refused; the assertion stays because the
        // outcome it protects is the one that matters.
        it('forbids a community owner/mod from closing a report about a photo they uploaded', async () => {
          reports.findOne.mockResolvedValue(photoReport());
          resolvedPhoto({ authorUserId: 'community-mod-1' });
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'dismiss',
                reasonCode: 'spam',
                note: 'Nothing to see here.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(reports.save).not.toHaveBeenCalled();
        });

        /**
         * A photo has a conflicted party a post does not. Attaching to an album
         * is organizer-only, so the host and co-hosts publish the album
         * together and a report about it is a complaint about something they
         * run. `authorIdForReportSubject` cannot see them, so the carve-out
         * asks the gathering directly.
         */
        it('forbids a community owner/mod who hosts the gathering the photo is in, now via the subject refusal that lands first', async () => {
          reports.findOne.mockResolvedValue(photoReport());
          // Somebody else uploaded it, so the author check would pass and only
          // the organizer check could catch this.
          resolvedPhoto({ authorUserId: 'uploader-1' });
          communityMembership.isOwnerOrMod.mockResolvedValue(true);
          dataSourceQuery.mockResolvedValue([{ one: 1 }]);

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'dismiss',
                reasonCode: 'spam',
                note: 'Nothing to see here.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          // TS-14 refuses every non-escalate action on an `event_photo` before
          // the carve-out resolves the community, so the organizer query is
          // never reached. `assertNotOrganiserOfReportedPhoto` is kept on
          // purpose: take `event_photo` back out of
          // `SUBJECT_TYPES_A_COMMUNITY_MOD_CANNOT_SEE` and it is load bearing
          // again immediately.
          expect(dataSourceQuery).not.toHaveBeenCalled();
          expect(reports.save).not.toHaveBeenCalled();
        });

        /**
         * `outing` and `doxxing` are `ReportSeverity.Emergency` with a one-hour
         * SLA, and they lead the photo reason set. Routing photos to a
         * community must not put the emergency band in its moderators' hands:
         * TS-07 already refuses every settling action there, and escalation
         * stays open so the report reaches trained staff in one call.
         */
        it('still refuses an emergency photo report to the community, and still lets it be escalated', async () => {
          reports.findOne.mockResolvedValue(
            photoReport({ severity: ReportSeverity.Emergency }),
          );
          resolvedPhoto();
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'dismiss',
                reasonCode: 'outing',
                note: 'Nothing to see here.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(reports.save).not.toHaveBeenCalled();

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'escalate',
              reasonCode: 'outing',
              note: 'Staff should decide this.',
            },
          );
          expect(res.status).toBe(ReportStatus.Escalated);
        });

        /**
         * TS-14: a community moderator cannot be shown the reported
         * photograph by ANY route. `GET /mod/report-photo-evidence/:reportId`
         * is `@Roles(Moderator, Admin)`, `GET /events/:slug/photos` is that
         * gathering's participants only, and `GET /files/gathering-photos/...`
         * is uploader-only. The emergency rule covers `outing` and `doxxing`
         * and stops there, so on the six non-emergency reason codes an
         * `event_photo` report carries they were being offered a takedown and
         * a platform-wide dismissal over a photo they had never seen.
         *
         * These tests are about the ACTION being narrowed. No test here, and
         * nothing in this change, gives anybody a new way to look at a
         * photograph.
         */
        describe('a photo a community moderator cannot see is not theirs to settle (TS-14)', () => {
          it.each(['dismiss', 'remove_content'] as const)(
            'forbids a community owner/mod from applying %s to a NON-emergency photo report, and says why',
            async (action) => {
              reports.findOne.mockResolvedValue(
                // Every non-emergency reason an `event_photo` report can
                // carry lands here. `harassment` stands for the six.
                photoReport({
                  reasonCode: 'harassment',
                  severity: ReportSeverity.High,
                }),
              );
              resolvedPhoto();
              communityMembership.isOwnerOrMod.mockResolvedValue(true);

              // The refusal names the real reason and the way forward. A bare
              // "not permitted" reads as a bug or a slight to the moderator
              // who was just offered the button.
              await expect(
                service.actOnReport(
                  'report-1',
                  'community-mod-1',
                  UserRole.Member,
                  {
                    action,
                    reasonCode: 'harassment',
                    note: 'Handled internally.',
                  },
                ),
              ).rejects.toThrow(/cannot be shown to you[\s\S]*escalate/i);
              expect(reports.save).not.toHaveBeenCalled();
              // Above all: no takedown was written for a photograph nobody in
              // the community could look at.
              expect(applyContentAction).not.toHaveBeenCalled();
            },
          );

          // The refusal must never be a dead end. Escalation is what carries
          // the community's local knowledge to the people who can see the
          // image, and it is the reason a photo report cannot get stuck in a
          // community queue with nothing its moderators may do.
          it('still lets a community owner/mod ESCALATE the same non-emergency photo report', async () => {
            reports.findOne.mockResolvedValue(
              photoReport({
                reasonCode: 'harassment',
                severity: ReportSeverity.High,
              }),
            );
            resolvedPhoto();
            communityMembership.isOwnerOrMod.mockResolvedValue(true);

            const res = await service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'escalate',
                reasonCode: 'harassment',
                note: 'The uploader was warned about this at the last event.',
              },
            );

            expect(res.status).toBe(ReportStatus.Escalated);
            // Escalating settles nothing and grants no visibility.
            expect(res).not.toHaveProperty('resolution');
            expect(res.reporter).toEqual({ anonymous: true });
          });

          // The rule is about who can SEE the photo, so it narrows the
          // community carve-out and touches platform staff nowhere: they have
          // `GET /mod/report-photo-evidence/:reportId` and decide as before.
          it.each(['dismiss', 'remove_content', 'escalate'] as const)(
            'leaves platform staff free to apply %s to the same photo report',
            async (action) => {
              reports.findOne.mockResolvedValue(
                photoReport({
                  reasonCode: 'harassment',
                  severity: ReportSeverity.High,
                }),
              );
              resolvedPhoto();

              const res = await service.actOnReport(
                'report-1',
                'staff-1',
                UserRole.Moderator,
                {
                  action,
                  reasonCode: 'harassment',
                  note: 'Reviewed the image.',
                },
              );

              expect(res.status).toBe(
                action === 'escalate'
                  ? ReportStatus.Escalated
                  : ReportStatus.Resolved,
              );
              // Staff authorize on their role, so the community roster is
              // never consulted for them.
              expect(communityMembership.isOwnerOrMod).not.toHaveBeenCalled();
            },
          );

          // The two refusals coexist and refuse for different reasons, so an
          // emergency photo report keeps answering with the emergency
          // sentence. Nobody reading the code should come away thinking one
          // rule replaced the other.
          it('keeps the emergency wording on an emergency photo report', async () => {
            reports.findOne.mockResolvedValue(
              photoReport({
                reasonCode: 'outing',
                severity: ReportSeverity.Emergency,
              }),
            );
            resolvedPhoto();
            communityMembership.isOwnerOrMod.mockResolvedValue(true);

            await expect(
              service.actOnReport(
                'report-1',
                'community-mod-1',
                UserRole.Member,
                {
                  action: 'dismiss',
                  reasonCode: 'outing',
                  note: 'Handled internally.',
                },
              ),
            ).rejects.toThrow(/trained platform staff/i);
          });
        });
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

      // The carve-out is three actions wide since TS-07/TS-08 (dismiss,
      // remove_content, escalate). Everything else is an account-level or
      // platform-wide consequence and stays staff-only.
      it.each(['warn', 'restrict', 'suspend', 'ban', 'hide_content'] as const)(
        'forbids a community owner/mod from applying %s, even within their own community',
        async (action) => {
          reports.findOne.mockResolvedValue(
            baseReport({
              subjectType: ReportSubjectType.Post,
              subjectId: 'post-1',
            }),
          );
          communityMembership.communityIdForPost.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action,
                reasonCode: 'hate_speech',
                note: 'Acting on the post.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(reports.save).not.toHaveBeenCalled();
        },
      );

      // TS-07. `report-severity.ts` maps outing/doxxing to Emergency, and the
      // dismissal a community mod could file was platform-wide and terminal.
      describe('an emergency report is not the community’s to settle (TS-07)', () => {
        const emergencyPostReport = () =>
          baseReport({
            subjectType: ReportSubjectType.Post,
            subjectId: 'post-1',
            reasonCode: 'outing',
            severity: ReportSeverity.Emergency,
          });

        it.each(['dismiss', 'remove_content'] as const)(
          'forbids a community owner/mod from applying %s to an emergency report, and says where it is going',
          async (action) => {
            reports.findOne.mockResolvedValue(emergencyPostReport());
            communityMembership.communityIdForPost.mockResolvedValue(
              'community-1',
            );
            communityMembership.isOwnerOrMod.mockResolvedValue(true);

            await expect(
              service.actOnReport(
                'report-1',
                'community-mod-1',
                UserRole.Member,
                { action, reasonCode: 'outing', note: 'Handled internally.' },
              ),
            ).rejects.toThrow(/trained platform staff/i);
            expect(reports.save).not.toHaveBeenCalled();
            expect(applyContentAction).not.toHaveBeenCalled();
          },
        );

        it('still lets a community owner/mod ESCALATE an emergency report, so the refusal is not a dead end', async () => {
          reports.findOne.mockResolvedValue(emergencyPostReport());
          communityMembership.communityIdForPost.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'escalate',
              reasonCode: 'outing',
              note: 'This needs staff.',
            },
          );

          expect(res.status).toBe(ReportStatus.Escalated);
          // Escalating settles nothing, so the report keeps no resolution
          // block and nobody is sanctioned.
          expect(res).not.toHaveProperty('resolution');
          expect(userUpdates()).toHaveLength(0);
          // Still redacted: escalating grants no report visibility either.
          expect(res.reporter).toEqual({ anonymous: true });
        });

        it('lets a community owner/mod escalate a report about their OWN post — sending it up is never self-dealing', async () => {
          reports.findOne.mockResolvedValue(emergencyPostReport());
          communityMembership.communityIdForPost.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);
          communityMembership.authorIdForPost.mockResolvedValue(
            'community-mod-1',
          );

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'escalate',
              reasonCode: 'outing',
              note: 'This is about me. Staff should decide.',
            },
          );

          expect(res.status).toBe(ReportStatus.Escalated);
        });
      });

      // TS-08. The console used to delete the post through the community
      // endpoint and then close the report as `dismiss` with an empty note, so
      // the audit trail read "Dismissed" for the most common community action
      // and no `content_moderation` row was ever written.
      describe('a community removal is recorded as a removal (TS-08)', () => {
        it('lets a community owner/mod remove the reported post, writing the takedown and the mod’s own reason', async () => {
          reports.findOne.mockResolvedValue(
            baseReport({
              subjectType: ReportSubjectType.Post,
              subjectId: 'post-1',
            }),
          );
          communityMembership.communityIdForPost.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'remove_content',
              reasonCode: 'hate_speech',
              note: 'This breaks rule 2.',
            },
          );

          expect(res.status).toBe(ReportStatus.Resolved);
          // The takedown goes through the same transaction as the report
          // close, exactly as the platform path already does.
          expect(applyContentAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              subjectType: ReportSubjectType.Post,
              subjectId: 'post-1',
              action: 'remove_content',
              actorId: 'community-mod-1',
              reportId: 'report-1',
              reasonCode: 'hate_speech',
              note: 'This breaks rule 2.',
            }),
          );
          const saveCalls = reports.save.mock.calls as [Report][];
          const savedReport = saveCalls[0]?.[0];
          expect(savedReport?.resolutionAction).toBe('remove_content');
          expect(savedReport?.resolutionNote).toBe('This breaks rule 2.');
        });

        it('lets a community owner/mod remove a reported REPLY the same way', async () => {
          reports.findOne.mockResolvedValue(
            baseReport({
              subjectType: ReportSubjectType.Reply,
              subjectId: 'reply-1',
            }),
          );
          communityMembership.communityIdForReply.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);

          const res = await service.actOnReport(
            'report-1',
            'community-mod-1',
            UserRole.Member,
            {
              action: 'remove_content',
              reasonCode: 'spam',
              note: 'Spam reply.',
            },
          );

          expect(res.status).toBe(ReportStatus.Resolved);
          expect(applyContentAction).toHaveBeenCalledWith(
            expect.anything(),
            expect.objectContaining({
              subjectType: ReportSubjectType.Reply,
              subjectId: 'reply-1',
              action: 'remove_content',
            }),
          );
        });

        it('forbids a community owner/mod from removing their OWN post through the report', async () => {
          reports.findOne.mockResolvedValue(
            baseReport({
              subjectType: ReportSubjectType.Post,
              subjectId: 'post-1',
            }),
          );
          communityMembership.communityIdForPost.mockResolvedValue(
            'community-1',
          );
          communityMembership.isOwnerOrMod.mockResolvedValue(true);
          communityMembership.authorIdForPost.mockResolvedValue(
            'community-mod-1',
          );

          await expect(
            service.actOnReport(
              'report-1',
              'community-mod-1',
              UserRole.Member,
              {
                action: 'remove_content',
                reasonCode: 'spam',
                note: 'Nothing to see here.',
              },
            ),
          ).rejects.toBeInstanceOf(ForbiddenException);
          expect(applyContentAction).not.toHaveBeenCalled();
        });
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
      // A member report with a resolvable account, so the suspend actually
      // lands and the reporter notification this test is about gets written.
      reports.find.mockResolvedValue([
        baseReport({
          id: 'report-1',
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
    // TS-11 replaced the one unpaginated `find` with two keyset-paged tabs, so
    // the assertion moved from "what did it ask the repository for" to "which
    // tab did the query builder describe". `appeals.createQueryBuilder` is the
    // shared mock builder, the same one the reports-queue tests read.
    it('pages the awaiting tab, soonest-due first', async () => {
      await service.listAppeals({});
      expect(appealsQb.andWhere).toHaveBeenCalledWith('a.status = :awaiting', {
        awaiting: AppealStatus.Awaiting,
      });
    });

    it('pages the decided tab as everything already decided', async () => {
      await service.listAppeals({ tab: 'decided' });
      expect(appealsQb.andWhere).toHaveBeenCalledWith('a.status != :awaiting', {
        awaiting: AppealStatus.Awaiting,
      });
    });

    it('narrows to appeals whose decision window has closed', async () => {
      await service.listAppeals({ tab: 'awaiting', filter: 'overdue' });
      expect(appealsQb.andWhere).toHaveBeenCalledWith('a.slaDueAt < :now', {
        now: expect.any(Date) as Date,
      });
    });

    // The overdue filter is meaningless on the decided tab and must not narrow
    // it: a decided appeal has no window left to be outside of.
    it('ignores the overdue filter on the decided tab', async () => {
      await service.listAppeals({ tab: 'decided', filter: 'overdue' });
      expect(appealsQb.andWhere).not.toHaveBeenCalledWith(
        'a.slaDueAt < :now',
        expect.anything(),
      );
    });
  });

  describe('submitAppeal (TS-11)', () => {
    // A real UUID, because the community-ban lookup guards its `community_bans`
    // read with a UUID shape test (a slug or content id in `target_user_id`
    // would be an "invalid input syntax for type uuid" from Postgres, not a
    // match) and returns null for anything else.
    const APPELLANT_ID = '11111111-2222-4333-8444-555555555555';
    const auditRow = (createdAt: Date) => ({
      id: 'log-1',
      reportId: null,
      actorId: 'mod-1',
      action: 'community_ban_applied',
      targetUserId: APPELLANT_ID,
      createdAt,
    });

    beforeEach(() => {
      profiles.findOne.mockResolvedValue(null);
      reports.find.mockResolvedValue([]);
      appeals.findOne.mockResolvedValue(null);
    });

    // Step 5, and the highest-value half of TS-11: a community ban writes a
    // report-less `mod_audit_logs` row with the barred member in
    // `target_user_id`, and used to be unappealable because the resolver only
    // ever looked through `member`-subject reports.
    it('resolves a report-less community ban as the appealed decision', async () => {
      auditLogs.findOne.mockResolvedValue(auditRow(new Date()));
      dataSourceQuery.mockResolvedValue([{ slug: 'lisbon-queers' }]);

      await service.submitAppeal(APPELLANT_ID, {
        reason: 'I was barred for a post that was not mine.',
      });

      expect(appeals.create).toHaveBeenCalledWith(
        expect.objectContaining({
          actionId: 'log-1',
          reportId: null,
          // Hardcoded `null` before TS-11, so every appeal reached the queue
          // with no idea which room it came out of.
          community: 'lisbon-queers',
          slaDueAt: expect.any(Date) as Date,
          decidedAt: null,
        }),
      );
    });

    it('refuses a filing more than 14 days after the decision', async () => {
      const longAgo = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000);
      auditLogs.findOne.mockResolvedValue(auditRow(longAgo));
      dataSourceQuery.mockResolvedValue([]);

      await expect(
        service.submitAppeal(APPELLANT_ID, {
          reason: 'This was a mistake and I would like it looked at again.',
        }),
      ).rejects.toThrow(/14 days/);
      expect(appeals.create).not.toHaveBeenCalled();
    });

    // No resolvable action means the software cannot say when the decision was
    // taken, so it has no honest basis for calling the member late.
    it('applies no deadline to a cold appeal', async () => {
      auditLogs.findOne.mockResolvedValue(null);

      await service.submitAppeal(APPELLANT_ID, {
        reason: 'Nobody told me what I did and I want it reviewed.',
      });

      expect(appeals.create).toHaveBeenCalledWith(
        expect.objectContaining({ actionId: null, community: null }),
      );
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
      slaDueAt: new Date('2026-01-09T00:00:00.000Z'),
      decidedAt: null,
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
      // `warn` resolves its target through the shared subject resolver now
      // (TS-02), so a member report has to resolve there as well as through
      // `profiles.findOne`.
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: 'user-1',
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
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

    // TS-12: a `ban` no longer removes the account here. It opens a
    // second-moderator ratification hold and suspends the member for exactly
    // the length of that hold, so the write carries the hold's expiry rather
    // than the permanent `suspendedUntil: null`. The permanent shape is
    // written later, by `applyRatifiedBan`, once a second moderator confirms.
    it('ban opens a ratification hold and suspends only for its window', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      expect(banRatifications.save).toHaveBeenCalledTimes(1);
      const [hold] = banRatifications.save.mock.calls[0] as [
        { targetUserId: string; expiresAt: Date; requestedBy: string | null },
      ];
      expect(hold.targetUserId).toBe('user-1');
      expect(hold.requestedBy).toBe('actor-1');

      const [, , patch] = userUpdates()[0]!;
      expect(patch.status).toBe(UserStatus.Suspended);
      // Never the permanent `null` before a second signature exists.
      expect(patch.suspendedUntil).toBeInstanceOf(Date);
      expect(patch.suspendedUntil?.getTime()).toBe(hold.expiresAt.getTime());
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

      // TS-12: while the hold stands, the member is suspended and nothing has
      // been removed, so the outcome they are told is the suspension it
      // currently is, with the hold's expiry. They hear again, as a ban, only
      // if a second moderator confirms it.
      it('a ban awaiting ratification notifies the member as the suspension it is', async () => {
        await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        });

        const call = memberCall();
        expect(call?.[0]).toBe('user-1');
        expect(call?.[2]).toMatchObject({ action: 'suspend' });
        expect(call?.[2]).toHaveProperty('expiresAt');
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

    // TS-03 replaced "a non-member report can never be suspended" with "it is
    // suspended against the AUTHOR the subject resolves to" (covered by
    // 'suspend lands on the post author instead of 400ing'). What survives,
    // and is the half that matters, is the fail-closed arm: a subject that
    // resolves to nobody still 400s and touches no account, rather than
    // silently no-op-ing into a resolved report nobody was sanctioned for.
    it('rejects suspend on a report whose subject resolves to no account', async () => {
      reports.findOne.mockResolvedValue(baseReport()); // subjectType: Post
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
      });

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
      // still recorded, so reactivating brings them back suspended. TS-12: the
      // recorded expiry is the ratification hold's, not the permanent `null`.
      const [, , patch] = userUpdates()[0]!;
      expect(patch).not.toHaveProperty('status');
      expect(patch.suspendedUntil).toBeInstanceOf(Date);
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
        baseReport({ id: 'report-2' }),
      ]);
      // `report-2` is a Post whose author resolves to nobody, so it is the
      // unenforceable half of the batch (TS-03 made a Post with a resolvable
      // author enforceable, so "a Post" is no longer what makes it fail).
      subjectResolver.resolve.mockImplementation((report: { id: string }) =>
        Promise.resolve(
          report.id === 'report-2'
            ? {
                authorUserId: null,
                excerpt: null,
                communityId: null,
                isAuthorAmbiguous: false,
              }
            : {
                authorUserId: 'user-1',
                excerpt: null,
                communityId: null,
                isAuthorAmbiguous: false,
              },
        ),
      );

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
      reports.find.mockResolvedValue([baseReport({ id: 'report-2' })]);
      // Unenforceable for the same reason as above: nobody behind the subject.
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
      });

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

  /**
   * TS-02 / TS-03 / TS-14: a report about CONTENT is most of the queue, and
   * until now it was the half of the queue where nothing could reach the person
   * behind it. `warn` notified nobody, `suspend`/`ban`/`restrict` threw a 400,
   * and the row could not name the community it came from.
   */
  describe('acting on the author of reported content', () => {
    const postReport = () =>
      baseReport({
        subjectType: ReportSubjectType.Post,
        subjectId: '11111111-2222-3333-4444-555555555555',
      });

    beforeEach(() => {
      reports.findOne.mockResolvedValue(postReport());
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: 'author-9',
        excerpt: 'the reported body',
        communityId: 'community-1',
        isAuthorAmbiguous: false,
      });
      users.findOne.mockResolvedValue({
        id: 'author-9',
        role: UserRole.Member,
        status: UserStatus.Active,
      });
    });

    const memberCall = () =>
      notificationsCreate.mock.calls.find(
        (args) => args[1] === NotificationType.ModerationOutcome,
      );

    it('warn reaches the post author (TS-02)', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'warn',
        reasonCode: 'harassment',
        note: 'Please stop.',
      });

      expect(memberCall()?.[0]).toBe('author-9');
    });

    /**
     * A `warn` with nobody to warn used to close the report and log "warned"
     * while notifying no one, which reads to the moderator exactly like a
     * warning that landed. It refuses now, the same way the three
     * account-changing actions already did.
     */
    it('warn refuses rather than resolving the report and telling nobody', async () => {
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
      });

      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'warn',
          reasonCode: 'harassment',
          note: 'n',
        }),
      ).rejects.toMatchObject({
        response: {
          code: 'ENFORCEMENT_TARGET_UNRESOLVED',
          target: 'no_account',
        },
      });

      expect(memberCall()).toBeUndefined();
      // The refusal is raised inside the action's transaction, so the report
      // is not closed on the way out.
      expect(auditLogs.save).not.toHaveBeenCalled();
    });

    it('suspend lands on the post author instead of 400ing (TS-03)', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'suspend',
        reasonCode: 'harassment',
        note: 'Seven days.',
        duration: '7d',
      });

      const [, where, patch] = userUpdates()[0]!;
      expect(where).toEqual({ id: 'author-9' });
      expect(patch.status).toBe(UserStatus.Suspended);
    });

    it('links the sanction to the report, so it is appealable as that decision', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'ban',
        reasonCode: 'harassment',
        note: 'Out.',
      });

      // TS-12: recorded as the hold it actually is, so the trail cannot claim
      // a member was removed while a second moderator has yet to confirm it.
      // The bare `ban` row is written by `BanRatificationService.decide`.
      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({
          reportId: 'report-1',
          action: BAN_PENDING_AUDIT_ACTION,
        }),
      );
    });

    it('restrict does not revoke the author’s sessions', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
        action: 'restrict',
        reasonCode: 'harassment',
        note: 'A week.',
        duration: '7d',
      });

      expect(revokeAllForUser).not.toHaveBeenCalled();
    });

    it('still refuses to sanction a staff account reached through content', async () => {
      users.findOne.mockResolvedValue({
        id: 'author-9',
        role: UserRole.Moderator,
        status: UserStatus.Active,
      });

      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('still refuses to sanction the house account reached through content', async () => {
      users.findOne.mockResolvedValue({
        id: 'author-9',
        role: UserRole.Member,
        status: UserStatus.Active,
        isSystem: true,
      });

      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('400s when the subject resolves to no account at all', async () => {
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: null,
        excerpt: null,
        communityId: null,
        isAuthorAmbiguous: false,
      });

      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Moderator, {
          action: 'ban',
          reasonCode: 'harassment',
          note: 'Out.',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    /**
     * The drawer used to show "Couldn't reach the safety service. Restored."
     * for all four of these, which is false in every one of them: the service
     * answered, and it answered for a reason. The code is the contract; the
     * `target` field says which case.
     */
    describe('every refusal carries a typed code', () => {
      const refusalBody = async (
        setUp: () => void,
      ): Promise<Record<string, unknown>> => {
        setUp();
        try {
          await service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
            action: 'ban',
            reasonCode: 'harassment',
            note: 'Out.',
          });
        } catch (error) {
          return (error as HttpException).getResponse() as Record<
            string,
            unknown
          >;
        }
        throw new Error('expected the action to be refused');
      };

      it('names an unresolvable subject as no_account', async () => {
        const body = await refusalBody(() =>
          subjectResolver.resolve.mockResolvedValue({
            authorUserId: null,
            excerpt: null,
            communityId: null,
            isAuthorAmbiguous: false,
          }),
        );

        expect(body).toMatchObject({
          statusCode: 400,
          code: 'ENFORCEMENT_TARGET_UNRESOLVED',
          target: 'no_account',
        });
        expect(typeof body.message).toBe('string');
      });

      it('names the house account', async () => {
        const body = await refusalBody(() =>
          users.findOne.mockResolvedValue({
            id: 'author-9',
            role: UserRole.Member,
            status: UserStatus.Active,
            isSystem: true,
          }),
        );

        expect(body).toMatchObject({
          statusCode: 403,
          code: 'ENFORCEMENT_TARGET_PROTECTED',
          target: 'house_account',
        });
      });

      it('names a staff account', async () => {
        const body = await refusalBody(() =>
          users.findOne.mockResolvedValue({
            id: 'author-9',
            role: UserRole.Moderator,
            status: UserStatus.Active,
          }),
        );

        expect(body).toMatchObject({
          statusCode: 403,
          code: 'ENFORCEMENT_TARGET_PROTECTED',
          target: 'staff_account',
        });
      });
    });

    it('shows the reported content, not only the complaint about it', async () => {
      profiles.findOne.mockResolvedValue({
        userId: 'author-9',
        slug: 'author-nine',
      });

      const row = await service.getById('report-1');

      expect(row.detail).toEqual(
        expect.objectContaining({
          contentAuthor: 'author-nine',
          excerpt: 'the reported body',
        }),
      );
    });

    it('names the community a post report came from (TS-14)', async () => {
      communityMembership.slugById.mockResolvedValue('porto-queers');

      const row = await service.getById('report-1');

      expect(row.community).toBe('porto-queers');
      expect(communityMembership.slugById).toHaveBeenCalledWith('community-1');
    });

    it('leaves the community null when the subject belongs to none', async () => {
      subjectResolver.resolve.mockResolvedValue({
        authorUserId: 'author-9',
        excerpt: null,
        communityId: null,
      });

      const row = await service.getById('report-1');

      expect(row.community).toBeNull();
      expect(communityMembership.slugById).not.toHaveBeenCalled();
    });
  });

  /**
   * A `listing_public_question` report covers the member's question AND the
   * listing owner's answer under it, and nothing on the wire says which half
   * was reported. The resolver names the ASKER as the author, so before this
   * fix a moderator reading an offending ANSWER and clicking Ban banned the
   * person who asked the question. Nothing 400d, nothing looked unusual, and
   * the audit row, the notification and the appeal would all have named the
   * wrong member, so the mistake was unlearnable.
   *
   * Account-level actions refuse now. Content-level actions are untouched:
   * hiding the exchange, removing it, dismissing or escalating the report all
   * still work, and none of them needs to know who wrote which half.
   */
  describe('an ambiguous subject refuses account-level enforcement', () => {
    beforeEach(() => {
      reports.findOne.mockResolvedValue(
        baseReport({
          subjectType: ReportSubjectType.ListingPublicQuestion,
          subjectId: '33333333-3333-3333-3333-333333333333',
        }),
      );
      subjectResolver.resolve.mockResolvedValue({
        // The asker IS resolved. Taking that as the target is the defect.
        authorUserId: 'asker-1',
        excerpt: 'is the entrance step-free? / read the sign',
        communityId: null,
        isAuthorAmbiguous: true,
      });
      users.findOne.mockResolvedValue({
        id: 'asker-1',
        role: UserRole.Member,
        status: UserStatus.Active,
      });
    });

    const refuses = (action: 'ban' | 'suspend' | 'restrict' | 'warn') =>
      it(`${action} refuses instead of guessing between the two authors`, async () => {
        await expect(
          service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
            action,
            reasonCode: 'harassment',
            note: 'Out.',
            ...(action === 'suspend' || action === 'restrict'
              ? { duration: '7d' }
              : {}),
          }),
        ).rejects.toMatchObject({
          response: {
            statusCode: 400,
            code: 'ENFORCEMENT_TARGET_UNRESOLVED',
            target: 'ambiguous_authors',
          },
        });

        // Nobody was sanctioned and nothing was written.
        expect(userUpdates()).toHaveLength(0);
        expect(auditLogs.save).not.toHaveBeenCalled();
      });

    refuses('ban');
    refuses('suspend');
    refuses('restrict');
    refuses('warn');

    it('never notifies the asker about an answer they did not write', async () => {
      await expect(
        service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
          action: 'warn',
          reasonCode: 'harassment',
          note: 'Out.',
        }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(notificationsCreate).not.toHaveBeenCalled();
    });

    it('still lets the moderator take the content down', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
        action: 'remove_content',
        reasonCode: 'harassment',
        note: 'Taken down.',
      });

      expect(applyContentAction).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          subjectType: ReportSubjectType.ListingPublicQuestion,
          action: 'remove_content',
        }),
      );
    });

    it('still lets the moderator dismiss the report', async () => {
      await service.actOnReport('report-1', 'actor-1', UserRole.Admin, {
        action: 'dismiss',
        reasonCode: 'other',
        note: 'Nothing wrong here.',
      });

      expect(auditLogs.save).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'dismiss' }),
      );
    });
  });

  describe('the queue names each report’s community (TS-14)', () => {
    it('batch-resolves a page in one resolver call plus one slug lookup', async () => {
      const rows = [
        baseReport({ id: 'report-1', subjectId: 'post-a' }),
        baseReport({ id: 'report-2', subjectId: 'post-b' }),
      ];
      reports.createQueryBuilder.mockReturnValue(qbStub(rows));
      subjectResolver.resolveMany.mockResolvedValue(
        new Map([
          [
            'report-1',
            { authorUserId: 'a', excerpt: null, communityId: 'community-1' },
          ],
          [
            'report-2',
            { authorUserId: 'b', excerpt: null, communityId: 'community-1' },
          ],
        ]),
      );
      communityMembership.refsByIds.mockResolvedValue(
        new Map([['community-1', { slug: 'porto-queers', name: 'Porto' }]]),
      );

      const page = await service.list({});

      expect(page.data.map((row) => row.community)).toEqual([
        'porto-queers',
        'porto-queers',
      ]);
      expect(subjectResolver.resolveMany).toHaveBeenCalledTimes(1);
      expect(communityMembership.refsByIds).toHaveBeenCalledTimes(1);
    });

    it('reads a community-subject report’s slug straight off the row', async () => {
      const rows = [
        baseReport({
          id: 'report-1',
          subjectType: ReportSubjectType.Community,
          subjectId: 'trans-and-friends',
        }),
      ];
      reports.createQueryBuilder.mockReturnValue(qbStub(rows));

      const page = await service.list({});

      expect(page.data[0]?.community).toBe('trans-and-friends');
      // A community subject needs no lookup at all: its `subjectId` IS the
      // slug, so the resolver is never asked.
      expect(subjectResolver.resolveMany).not.toHaveBeenCalled();
    });

    it('narrows the queue to one community when asked', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ community: 'porto-queers' });

      const andWhere = qb.andWhere as jest.Mock;
      const communityWhere = (andWhere.mock.calls as [string, unknown][])
        .map(([sql]) => sql)
        .find((sql) => sql.includes('community_posts'));
      expect(communityWhere).toBeDefined();
    });
  });

  describe('the queue clusters a pile-on by subject (TS-06)', () => {
    const clusterRow = (overrides: Record<string, unknown> = {}) => ({
      subjectType: ReportSubjectType.Member,
      subjectId: 'reported-member',
      openCount: 30,
      distinctReporterCount: 30,
      overdueCount: 4,
      severityRank: 1,
      firstReportedAt: new Date('2026-01-01T10:00:00.000Z'),
      lastReportedAt: new Date('2026-01-01T10:10:00.000Z'),
      reportIds: ['report-1', 'report-2'],
      ...overrides,
    });

    it('summarizes every open report about the page’s subjects, not just the ones on the page', async () => {
      const qb = qbStub([
        baseReport({
          id: 'report-1',
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      ]);
      reports.createQueryBuilder.mockReturnValue(qb);
      dataSourceQuery.mockResolvedValue([clusterRow()]);

      const page = await service.list({ tab: 'open' });

      expect(page.clusters).toEqual([
        {
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
          openCount: 30,
          distinctReporterCount: 30,
          overdueCount: 4,
          highestSeverity: ReportSeverity.High,
          firstReportedAt: '2026-01-01T10:00:00.000Z',
          lastReportedAt: '2026-01-01T10:10:00.000Z',
          isSurge: true,
          reportIds: ['report-1', 'report-2'],
        },
      ]);
      // One statement for the whole page, whatever its size.
      expect(dataSourceQuery).toHaveBeenCalledTimes(1);
    });

    it('drops an aggregate row that is not actually on this page', async () => {
      const qb = qbStub([
        baseReport({
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      ]);
      reports.createQueryBuilder.mockReturnValue(qb);
      // Same id, different subject type: the two `ANY(...)` lists are matched
      // independently, so the aggregate can be very slightly wider than the
      // page. It is narrowed back before anything is returned.
      dataSourceQuery.mockResolvedValue([
        clusterRow({ subjectType: ReportSubjectType.Post }),
      ]);

      const page = await service.list({ tab: 'open' });

      expect(page.clusters).toEqual([]);
    });

    it('does not call a pile a surge when one person filed all of it', async () => {
      const qb = qbStub([
        baseReport({
          subjectType: ReportSubjectType.Member,
          subjectId: 'reported-member',
        }),
      ]);
      reports.createQueryBuilder.mockReturnValue(qb);
      dataSourceQuery.mockResolvedValue([
        clusterRow({ openCount: 6, distinctReporterCount: 1 }),
      ]);

      const page = await service.list({ tab: 'open' });

      expect(page.clusters[0]?.isSurge).toBe(false);
      // The cluster is still reported: six open reports about one subject is
      // worth seeing as one thing even when one member filed them all.
      expect(page.clusters[0]?.openCount).toBe(6);
    });

    it('asks for no clusters at all on an empty page', async () => {
      reports.createQueryBuilder.mockReturnValue(qbStub([]));

      const page = await service.list({ tab: 'open' });

      expect(page.clusters).toEqual([]);
      expect(dataSourceQuery).not.toHaveBeenCalled();
    });

    it('narrows the queue to overdue reports when asked', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ tab: 'open', filter: 'overdue' });

      expect(qb.andWhere).toHaveBeenCalledWith('r.slaDueAt < now()');
      expect(qb.andWhere).toHaveBeenCalledWith(
        'r.status != :resolvedForOverdue',
        {
          resolvedForOverdue: ReportStatus.Resolved,
        },
      );
    });

    it('narrows the queue to surges using the auto-freeze thresholds', async () => {
      const qb = qbStub([]);
      reports.createQueryBuilder.mockReturnValue(qb);

      await service.list({ tab: 'open', filter: 'surge' });

      const andWhere = qb.andWhere as jest.Mock;
      const surgeCall = (
        andWhere.mock.calls as [string, Record<string, unknown>?][]
      ).find(([sql]) => sql.includes('surgeMinReporters'));
      expect(surgeCall).toBeDefined();
      expect(surgeCall?.[1]).toEqual({
        surgeOpenStatuses: [ReportStatus.Open, ReportStatus.Escalated],
        surgeMinOpen: 5,
        surgeMinReporters: 3,
      });
    });
  });
});
