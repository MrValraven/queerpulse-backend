import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { CommunityMember } from '../communities/entities/community-member.entity';
import { Community } from '../communities/entities/community.entity';
import { JoinRequest } from '../membership/entities/join-request.entity';
import { Appeal } from '../moderation/entities/appeal.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { UsersService } from '../users/users.service';
import { Vouch } from '../vouch/entities/vouch.entity';
import { AdminOverviewService } from './admin-overview.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS);
}

/** Only the fields this service actually reads off a `Report` row for the
 *  open-reports / reports-by-type / feed queries — the rest is irrelevant to
 *  it and left off deliberately. */
function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    subjectType: ReportSubjectType.Member,
    subjectId: 'user-someone',
    reasonCode: 'harassment',
    detail: null,
    anonymous: false,
    contactEmail: null,
    evidence: null,
    severity: ReportSeverity.High,
    slaDueAt: daysAgo(-1),
    status: ReportStatus.Open,
    reporterId: 'user-reporter',
    createdAt: daysAgo(2),
    ...overrides,
  };
}

interface MockRepo {
  count: jest.Mock;
  find: jest.Mock;
}

function makeMockRepo(): MockRepo {
  return {
    count: jest.fn().mockResolvedValue(0),
    find: jest.fn().mockResolvedValue([]),
  };
}

describe('AdminOverviewService', () => {
  let service: AdminOverviewService;
  let profiles: MockRepo;
  let reports: MockRepo;
  let joinRequests: MockRepo;
  let appeals: MockRepo;
  let modAuditLogs: MockRepo;
  let vouches: MockRepo;
  let communityMembers: MockRepo;
  let communities: MockRepo;
  let usersService: { countActiveMembers: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    profiles = makeMockRepo();
    reports = makeMockRepo();
    joinRequests = makeMockRepo();
    appeals = makeMockRepo();
    modAuditLogs = makeMockRepo();
    vouches = makeMockRepo();
    communityMembers = makeMockRepo();
    communities = makeMockRepo();
    usersService = { countActiveMembers: jest.fn().mockResolvedValue(8412) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminOverviewService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(JoinRequest), useValue: joinRequests },
        { provide: getRepositoryToken(Appeal), useValue: appeals },
        { provide: getRepositoryToken(ModAuditLog), useValue: modAuditLogs },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Community), useValue: communities },
        { provide: UsersService, useValue: usersService },
      ],
    }).compile();

    service = module.get(AdminOverviewService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('getOverview', () => {
    it('never fabricates the un-backed sustainer metrics', async () => {
      const result = await service.getOverview();

      expect(result.stats.sustainerMrr).toBeNull();
      expect(result.stats.sustainerCount).toBeNull();
    });

    it('never fabricates churn — every member-growth point reports it as null', async () => {
      const result = await service.getOverview();

      expect(result.memberGrowth.points.length).toBeGreaterThan(0);
      for (const point of result.memberGrowth.points) {
        expect(point.churned).toBeNull();
      }
    });

    it('always returns exactly eight reports-by-type week buckets, zero-filled with no data', async () => {
      const result = await service.getOverview();

      expect(result.reportsByType.weeks).toHaveLength(8);
      for (const week of result.reportsByType.weeks) {
        expect(week.values).toEqual([0, 0, 0, 0]);
      }
    });

    it('takes stats.activeMembers.value from the injected UsersService, not a repository count', async () => {
      const result = await service.getOverview();

      expect(result.stats.activeMembers.value).toBe(8412);
      expect(usersService.countActiveMembers).toHaveBeenCalledTimes(1);
    });

    it('computes the response-time median and buckets from resolved reports paired with their resolving audit row', async () => {
      reports.find.mockImplementation((options: Record<string, unknown>) => {
        const where = options?.where as { status?: ReportStatus } | undefined;
        if (where?.status === ReportStatus.Resolved) {
          return Promise.resolve([
            makeReport({
              id: 'report-resolved-1',
              status: ReportStatus.Resolved,
              createdAt: daysAgo(3),
            }),
          ]);
        }
        return Promise.resolve([]);
      });
      modAuditLogs.find.mockResolvedValue([
        {
          id: 'audit-1',
          reportId: 'report-resolved-1',
          actorId: 'user-mod',
          action: 'dismiss',
          reasonCode: null,
          note: null,
          duration: null,
          // Resolved two days after filing => 48 hours.
          createdAt: daysAgo(1),
        } as ModAuditLog,
      ]);

      const result = await service.getOverview();

      expect(result.responseTime).not.toBeNull();
      expect(result.responseTime?.medianHours).toBe(48);
      expect(result.stats.medianResponseHours).toBe(48);
    });

    it('reports null response time and median when no resolved report has a resolving audit row', async () => {
      const result = await service.getOverview();

      expect(result.responseTime).toBeNull();
      expect(result.stats.medianResponseHours).toBeNull();
    });

    it('keeps triage.openReports and stats.openReports.value as the same total-open count', async () => {
      reports.find.mockImplementation((options: Record<string, unknown>) => {
        const where = options?.where as { status?: unknown } | undefined;
        if (
          where?.status &&
          typeof where.status === 'object' &&
          'value' in where.status
        ) {
          // status: In([Open, Escalated])
          return Promise.resolve([
            makeReport({
              severity: ReportSeverity.Emergency,
              status: ReportStatus.Open,
            }),
            makeReport({
              severity: ReportSeverity.Low,
              status: ReportStatus.Open,
            }),
          ]);
        }
        return Promise.resolve([]);
      });

      const result = await service.getOverview();

      expect(result.stats.openReports.value).toBe(2);
      expect(result.triage.openReports).toBe(2);
      expect(result.stats.openReports.emergencies).toBe(1);
      expect(result.triage.emergencies).toBe(1);
    });
  });
});
