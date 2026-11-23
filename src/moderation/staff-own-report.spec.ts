import { ForbiddenException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { AdminQueueNotificationsService } from '../admin-queue-notifications/admin-queue-notifications.service';
import { AuthService } from '../auth/auth.service';
import { CommunityMembershipService } from '../communities/community-membership.service';
import { ContentModerationService } from '../content-moderation/content-moderation.service';
import { IdentitiesService } from '../identities/identities.service';
import { Listing } from '../listings/entities/listing.entity';
import { NotificationsService } from '../notifications/notifications.service';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User, UserRole } from '../users/entities/user.entity';
import { AccountEnforcementService } from './account-enforcement.service';
import { ModActionCode } from './dto/mod-action.dto';
import { BanRatificationService } from './ban-ratification.service';
import { Appeal } from './entities/appeal.entity';
import { ModAuditLog } from './entities/mod-audit-log.entity';
import { ModAuditService } from './mod-audit.service';
import { ModerationService } from './moderation.service';
import { REPORT_ABOUT_ACTOR_CODE } from './report-about-actor';
import { ReportSubjectResolverService } from './report-subject-resolver.service';

/**
 * SEC-31: a platform staff member never sees, opens or acts on a report whose
 * subject is themselves or something they authored, and every other staff
 * member still does.
 */

const REPORTED_STAFF_ID = '11111111-1111-4111-8111-111111111111';
const COLLEAGUE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_MEMBER_ID = '33333333-3333-4333-8333-333333333333';

function buildReport(overrides: Partial<Report>): Report {
  return Object.assign(new Report(), {
    id: 'report-1',
    subjectType: ReportSubjectType.Member,
    subjectId: OTHER_MEMBER_ID,
    reasonCode: 'harassment',
    detail: 'They keep messaging me after I asked them to stop.',
    anonymous: false,
    contactEmail: null,
    anonymousReporterKey: null,
    evidence: null,
    severity: ReportSeverity.High,
    slaDueAt: new Date('2026-11-23T12:00:00.000Z'),
    status: ReportStatus.Open,
    reporterId: OTHER_MEMBER_ID,
    assignedModeratorId: null,
    assignedAt: null,
    resolvedAt: null,
    resolutionActorId: null,
    resolutionAction: null,
    resolutionDuration: null,
    resolutionNote: null,
    resolutionNotified: null,
    createdAt: new Date('2026-11-23T08:00:00.000Z'),
    ...overrides,
  });
}

interface SubjectResolution {
  authorUserId: string | null;
  excerpt: string | null;
  communityId: string | null;
  isAuthorAmbiguous: boolean;
}

function resolution(authorUserId: string | null): SubjectResolution {
  return {
    authorUserId,
    excerpt: null,
    communityId: null,
    isAuthorAmbiguous: false,
  };
}

interface QueryBuilderStub {
  andWhere: jest.Mock;
  orderBy: jest.Mock;
  addOrderBy: jest.Mock;
  take: jest.Mock;
  select: jest.Mock;
  addSelect: jest.Mock;
  where: jest.Mock;
  groupBy: jest.Mock;
  getMany: jest.Mock;
  getRawMany: jest.Mock;
  update: jest.Mock;
  set: jest.Mock;
  execute: jest.Mock;
}

function queryBuilderStub(rows: Report[]): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {
    andWhere: jest.fn(),
    orderBy: jest.fn(),
    addOrderBy: jest.fn(),
    take: jest.fn(),
    select: jest.fn(),
    addSelect: jest.fn(),
    where: jest.fn(),
    groupBy: jest.fn(),
    getMany: jest.fn().mockResolvedValue(rows),
    getRawMany: jest.fn().mockResolvedValue([]),
    update: jest.fn(),
    set: jest.fn(),
    execute: jest.fn().mockResolvedValue({ affected: 1 }),
  };
  for (const chained of [
    queryBuilder.andWhere,
    queryBuilder.orderBy,
    queryBuilder.addOrderBy,
    queryBuilder.take,
    queryBuilder.select,
    queryBuilder.addSelect,
    queryBuilder.where,
    queryBuilder.groupBy,
    queryBuilder.update,
    queryBuilder.set,
  ]) {
    chained.mockReturnValue(queryBuilder);
  }
  return queryBuilder;
}

interface ReportsRepositoryStub {
  findOne: jest.Mock;
  find: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
}

interface SubjectResolverStub {
  resolve: jest.Mock;
  resolveMany: jest.Mock;
}

interface AuditStub {
  auditTrail: jest.Mock;
  namesForUserIds: jest.Mock;
  nameForUserId: jest.Mock;
  resolveActorName: jest.Mock;
}

interface IdentitiesStub {
  describeIdentities: jest.Mock;
  staffUserIds: jest.Mock;
}

interface DataSourceStub {
  transaction: jest.Mock;
  query: jest.Mock;
}

describe('ModerationService: staff never handle reports about themselves (SEC-31)', () => {
  let service: ModerationService;
  let reports: ReportsRepositoryStub;
  let subjectResolver: SubjectResolverStub;
  let audit: AuditStub;
  let dataSource: DataSourceStub;
  let identities: IdentitiesStub;

  beforeEach(async () => {
    reports = {
      findOne: jest.fn().mockResolvedValue(null),
      find: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      createQueryBuilder: jest.fn(() => queryBuilderStub([])),
    };
    subjectResolver = {
      resolve: jest.fn().mockResolvedValue(resolution(null)),
      resolveMany: jest.fn().mockResolvedValue(new Map()),
    };
    audit = {
      auditTrail: jest.fn().mockResolvedValue([]),
      namesForUserIds: jest.fn().mockResolvedValue(new Map()),
      nameForUserId: jest.fn().mockResolvedValue('Member'),
      resolveActorName: jest.fn().mockReturnValue('Member'),
    };
    dataSource = {
      transaction: jest.fn(),
      query: jest.fn().mockResolvedValue([]),
    };
    identities = {
      describeIdentities: jest.fn().mockResolvedValue(new Map()),
      staffUserIds: jest.fn().mockResolvedValue([]),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ModerationService,
        { provide: getRepositoryToken(Report), useValue: reports },
        {
          provide: getRepositoryToken(Appeal),
          useValue: { count: jest.fn().mockResolvedValue(0) },
        },
        { provide: getRepositoryToken(ModAuditLog), useValue: {} },
        {
          provide: getRepositoryToken(Profile),
          useValue: {
            find: jest.fn().mockResolvedValue([]),
            findOne: jest.fn().mockResolvedValue(null),
          },
        },
        { provide: getRepositoryToken(User), useValue: {} },
        { provide: getRepositoryToken(Listing), useValue: {} },
        { provide: DataSource, useValue: dataSource },
        { provide: AuthService, useValue: {} },
        { provide: ModAuditService, useValue: audit },
        { provide: AccountEnforcementService, useValue: {} },
        { provide: ContentModerationService, useValue: {} },
        { provide: NotificationsService, useValue: {} },
        {
          provide: CommunityMembershipService,
          useValue: { refsByIds: jest.fn().mockResolvedValue(new Map()) },
        },
        { provide: ReportSubjectResolverService, useValue: subjectResolver },
        { provide: EventEmitter2, useValue: { emit: jest.fn() } },
        { provide: BanRatificationService, useValue: {} },
        { provide: AdminQueueNotificationsService, useValue: {} },
        { provide: IdentitiesService, useValue: identities },
      ],
    }).compile();
    service = module.get(ModerationService);
  });

  async function expectReportAboutActorRefusal(
    pending: Promise<unknown>,
  ): Promise<void> {
    const outcome = await pending.then(
      () => null,
      (error: unknown) => error,
    );
    expect(outcome).toBeInstanceOf(ForbiddenException);
    if (outcome instanceof ForbiddenException) {
      expect(outcome.getResponse()).toMatchObject({
        code: REPORT_ABOUT_ACTOR_CODE,
      });
      // The refusal names what happens next and nothing about the report.
      expect(outcome.message).not.toContain(OTHER_MEMBER_ID);
    }
  }

  describe('isReportAboutActor', () => {
    it('matches a member report filed against the staff member by user id', async () => {
      const report = buildReport({ subjectId: REPORTED_STAFF_ID });

      await expect(
        service.isReportAboutActor(report, REPORTED_STAFF_ID),
      ).resolves.toBe(true);
    });

    it('matches a report on content the staff member authored', async () => {
      subjectResolver.resolve.mockResolvedValue(resolution(REPORTED_STAFF_ID));
      const report = buildReport({
        subjectType: ReportSubjectType.Post,
        subjectId: '44444444-4444-4444-8444-444444444444',
      });

      await expect(
        service.isReportAboutActor(report, REPORTED_STAFF_ID),
      ).resolves.toBe(true);
    });

    it('falls back to the filing-time snapshot once the photo is deleted', async () => {
      // The uploader removed the photo after the filing, so the live row is
      // gone and the resolver names nobody.
      subjectResolver.resolve.mockResolvedValue(resolution(null));
      const report = buildReport({
        subjectType: ReportSubjectType.EventPhoto,
        subjectId: '66666666-6666-4666-8666-666666666666',
        evidence: [
          {
            type: 'photo-snapshot',
            photoId: '66666666-6666-4666-8666-666666666666',
            eventId: '77777777-7777-4777-8777-777777777777',
            storageKey: 'photos/a/b.jpg',
            caption: null,
            uploaderId: REPORTED_STAFF_ID,
            uploadedAt: '2026-11-20T10:00:00.000Z',
            snapshotAt: '2026-11-21T10:00:00.000Z',
          },
        ],
      });

      await expect(
        service.isReportAboutActor(report, REPORTED_STAFF_ID),
      ).resolves.toBe(true);
      await expect(
        service.isReportAboutActor(report, COLLEAGUE_ID),
      ).resolves.toBe(false);
    });

    it('matches a co-owner of a reported persona through its mailbox staff', async () => {
      subjectResolver.resolve.mockResolvedValue(resolution(OTHER_MEMBER_ID));
      dataSource.query.mockResolvedValue([
        {
          slugKey: 'night-persona',
          idKey: '88888888-8888-4888-8888-888888888888',
          identityId: 'identity-persona',
        },
      ]);
      identities.staffUserIds.mockResolvedValue([
        OTHER_MEMBER_ID,
        REPORTED_STAFF_ID,
      ]);
      const report = buildReport({
        subjectType: ReportSubjectType.Subprofile,
        subjectId: '88888888-8888-4888-8888-888888888888',
      });

      await expect(
        service.isReportAboutActor(report, REPORTED_STAFF_ID),
      ).resolves.toBe(true);
      expect(identities.staffUserIds).toHaveBeenCalledWith('identity-persona');
    });

    it('leaves the same report open to a colleague', async () => {
      subjectResolver.resolve.mockResolvedValue(resolution(REPORTED_STAFF_ID));
      const report = buildReport({ subjectId: REPORTED_STAFF_ID });

      await expect(
        service.isReportAboutActor(report, COLLEAGUE_ID),
      ).resolves.toBe(false);
    });
  });

  it('refuses the reported staff member the drawer read with a reason code', async () => {
    reports.findOne.mockResolvedValue(
      buildReport({ subjectId: REPORTED_STAFF_ID }),
    );

    await expectReportAboutActorRefusal(
      service.getById('report-1', REPORTED_STAFF_ID),
    );
  });

  it('refuses every action on a report about their own content, escalate included, and writes nothing', async () => {
    subjectResolver.resolve.mockResolvedValue(resolution(REPORTED_STAFF_ID));
    reports.findOne.mockResolvedValue(
      buildReport({
        subjectType: ReportSubjectType.Message,
        subjectId: '55555555-5555-4555-8555-555555555555',
      }),
    );

    const actions: ModActionCode[] = ['dismiss', 'escalate'];
    for (const action of actions) {
      await expectReportAboutActorRefusal(
        service.actOnReport('report-1', REPORTED_STAFF_ID, UserRole.Admin, {
          action,
          reasonCode: 'harassment',
          note: 'Closing this.',
        }),
      );
    }
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('refuses self-assignment of a report about the staff member', async () => {
    reports.findOne.mockResolvedValue(
      buildReport({ subjectId: REPORTED_STAFF_ID }),
    );

    await expectReportAboutActorRefusal(
      service.setAssignment(
        'report-1',
        REPORTED_STAFF_ID,
        UserRole.Moderator,
        true,
      ),
    );
  });

  it('refuses the audit trail of a report about the staff member', async () => {
    reports.findOne.mockResolvedValue(
      buildReport({ subjectId: REPORTED_STAFF_ID }),
    );

    await expectReportAboutActorRefusal(
      service.auditTrail('report-1', REPORTED_STAFF_ID),
    );
    expect(audit.auditTrail).not.toHaveBeenCalled();
  });

  it('lands a bulk-selected report about the staff member in failed and runs nothing for it', async () => {
    reports.find.mockResolvedValue([
      buildReport({ subjectId: REPORTED_STAFF_ID }),
    ]);

    const result = await service.bulkActOnReports(REPORTED_STAFF_ID, {
      ids: ['report-1'],
      action: 'dismiss',
      reasonCode: 'harassment',
      note: 'Closing these.',
    });

    expect(result.updated).toEqual([]);
    expect(result.failed.map((failure) => failure.id)).toEqual(['report-1']);
    expect(result.failed[0]?.reason).toContain('another staff member');
    expect(result.failed[0]?.code).toBe(REPORT_ABOUT_ACTOR_CODE);
    expect(dataSource.transaction).not.toHaveBeenCalled();
  });

  it('drops reports about the staff member from their queue and keeps them in a colleague’s', async () => {
    const aboutStaff = buildReport({
      id: 'report-about-staff',
      subjectId: REPORTED_STAFF_ID,
    });
    const aboutSomeoneElse = buildReport({
      id: 'report-about-member',
      subjectId: OTHER_MEMBER_ID,
    });
    reports.createQueryBuilder.mockImplementation(() =>
      queryBuilderStub([aboutStaff, aboutSomeoneElse]),
    );

    const staffPage = await service.list({}, REPORTED_STAFF_ID);
    const colleaguePage = await service.list({}, COLLEAGUE_ID);

    expect(staffPage.data.map((row) => row.id)).toEqual([
      'report-about-member',
    ]);
    expect(colleaguePage.data.map((row) => row.id)).toEqual([
      'report-about-staff',
      'report-about-member',
    ]);
  });

  it('releases a report its own subject had claimed when the queue is read', async () => {
    const claimedBySubject = buildReport({
      id: 'report-claimed-by-subject',
      subjectId: REPORTED_STAFF_ID,
      assignedModeratorId: REPORTED_STAFF_ID,
      assignedAt: new Date('2026-11-22T09:00:00.000Z'),
    });
    const listQueryBuilder = queryBuilderStub([claimedBySubject]);
    reports.createQueryBuilder.mockImplementation(() => listQueryBuilder);

    const colleaguePage = await service.list({}, COLLEAGUE_ID);

    expect(listQueryBuilder.set).toHaveBeenCalledWith({
      assignedModeratorId: null,
      assignedAt: null,
    });
    expect(listQueryBuilder.andWhere).toHaveBeenCalledWith(
      'assigned_moderator_id = :assigneeId',
      { assigneeId: REPORTED_STAFF_ID },
    );
    expect(colleaguePage.data[0]?.assignedModeratorId).toBeNull();
  });
});
