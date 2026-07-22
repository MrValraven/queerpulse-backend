import { NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import {
  CommunityMember,
  RosterRole,
} from '../communities/entities/community-member.entity';
import { ModAuditLog } from '../moderation/entities/mod-audit-log.entity';
import {
  Report,
  ReportSeverity,
  ReportStatus,
  ReportSubjectType,
} from '../reports/entities/report.entity';
import { Profile } from '../users/entities/profile.entity';
import { User } from '../users/entities/user.entity';
import { Vouch } from '../vouch/entities/vouch.entity';
import { VouchService } from '../vouch/vouch.service';
import {
  AdminMembersService,
  ADMIN_MEMBERS_PAGE_SIZE,
} from './admin-members.service';

const DAY_MS = 24 * 60 * 60 * 1000;
const FIXED_NOW = new Date('2026-07-21T12:00:00.000Z');

function daysAgo(days: number): Date {
  return new Date(FIXED_NOW.getTime() - days * DAY_MS);
}

/** Only the fields this service actually reads off a `Profile` row — the rest
 *  is irrelevant to it and left off deliberately. */
function makeProfile(overrides: Partial<Profile> = {}): Profile {
  return {
    userId: 'user-ines',
    slug: 'ines-martins',
    firstName: 'Inês',
    lastName: 'Martins',
    pronouns: 'she/her',
    tagline: 'Softly, together.',
    avatarUrl: null,
    verified: true,
    joinedAt: daysAgo(200),
    ...overrides,
  } as unknown as Profile;
}

function makeReport(overrides: Partial<Report> = {}): Report {
  return {
    id: 'report-1',
    subjectType: ReportSubjectType.Member,
    subjectId: 'user-ines',
    reasonCode: 'harassment',
    detail: 'Repeated targeting in the thread.',
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

type QueryBuilderStub = Record<string, jest.Mock>;

const CHAINED_BUILDER_METHODS = [
  'select',
  'addSelect',
  'innerJoin',
  'where',
  'andWhere',
  'groupBy',
  'orderBy',
  'skip',
  'take',
];

/** Stubs the fluent `createQueryBuilder` chain: every builder method returns
 *  the builder itself; the three possible terminal methods each resolve to
 *  whatever is passed in (defaulting to "no rows"), since which terminal
 *  method a given call site uses depends on the query. */
function makeQueryBuilderStub(
  terminals: {
    getMany?: unknown[];
    getManyAndCount?: [unknown[], number];
    getRawMany?: unknown[];
  } = {},
): QueryBuilderStub {
  const queryBuilder: QueryBuilderStub = {};
  for (const chainedMethod of CHAINED_BUILDER_METHODS) {
    queryBuilder[chainedMethod] = jest.fn().mockReturnValue(queryBuilder);
  }
  queryBuilder.getMany = jest.fn().mockResolvedValue(terminals.getMany ?? []);
  queryBuilder.getManyAndCount = jest
    .fn()
    .mockResolvedValue(terminals.getManyAndCount ?? [[], 0]);
  queryBuilder.getRawMany = jest
    .fn()
    .mockResolvedValue(terminals.getRawMany ?? []);
  return queryBuilder;
}

describe('AdminMembersService', () => {
  let service: AdminMembersService;
  let profiles: { find: jest.Mock; findOne: jest.Mock; createQueryBuilder: jest.Mock };
  let users: { find: jest.Mock };
  let vouches: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let communityMembers: { createQueryBuilder: jest.Mock };
  let reports: { find: jest.Mock; createQueryBuilder: jest.Mock };
  let modAuditLogs: { find: jest.Mock };
  let vouchService: { getVouchCounts: jest.Mock; getVouchCount: jest.Mock };

  beforeEach(async () => {
    jest.useFakeTimers().setSystemTime(FIXED_NOW);

    profiles = {
      find: jest.fn().mockResolvedValue([]),
      findOne: jest.fn(),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    users = { find: jest.fn().mockResolvedValue([]) };
    vouches = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    communityMembers = {
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    reports = {
      find: jest.fn().mockResolvedValue([]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderStub()),
    };
    modAuditLogs = { find: jest.fn().mockResolvedValue([]) };
    vouchService = {
      getVouchCounts: jest.fn().mockResolvedValue(new Map()),
      getVouchCount: jest.fn().mockResolvedValue(0),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        AdminMembersService,
        { provide: getRepositoryToken(Profile), useValue: profiles },
        { provide: getRepositoryToken(User), useValue: users },
        { provide: getRepositoryToken(Vouch), useValue: vouches },
        {
          provide: getRepositoryToken(CommunityMember),
          useValue: communityMembers,
        },
        { provide: getRepositoryToken(Report), useValue: reports },
        { provide: getRepositoryToken(ModAuditLog), useValue: modAuditLogs },
        { provide: VouchService, useValue: vouchService },
      ],
    }).compile();

    service = module.get(AdminMembersService);
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('list', () => {
    it('returns a paginated envelope with each row adapted into a card', async () => {
      const profileRow = makeProfile();
      profiles.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getManyAndCount: [[profileRow], 1] }),
      );
      // Every other grouped query is stubbed to "no rows" per the harness
      // note in the task brief — this test only exercises the envelope shape
      // and the vouch-count wiring, not every batched aggregate.
      vouches.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getMany: [] }),
      );
      reports.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getRawMany: [] }),
      );
      communityMembers.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getRawMany: [] }),
      );
      vouchService.getVouchCounts.mockResolvedValue(
        new Map([[profileRow.userId, 3]]),
      );

      const result = await service.list({ page: 1 });

      expect(result.total).toBe(1);
      expect(result.page).toBe(1);
      expect(result.pageSize).toBe(ADMIN_MEMBERS_PAGE_SIZE);
      expect(result.items).toHaveLength(1);
      expect(result.items[0]).toMatchObject({
        slug: 'ines-martins',
        name: 'Inês Martins',
        initials: 'IM',
        vouchCount: 3,
      });
    });

    it('defaults to page 1 and returns an empty envelope with no members', async () => {
      profiles.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({ getManyAndCount: [[], 0] }),
      );

      const result = await service.list({});

      expect(result).toEqual({
        items: [],
        total: 0,
        page: 1,
        pageSize: ADMIN_MEMBERS_PAGE_SIZE,
      });
      // No member rows means none of the per-page aggregate queries should
      // ever run.
      expect(vouchService.getVouchCounts).not.toHaveBeenCalled();
      expect(vouches.createQueryBuilder).not.toHaveBeenCalled();
      expect(reports.createQueryBuilder).not.toHaveBeenCalled();
      expect(communityMembers.createQueryBuilder).not.toHaveBeenCalled();
    });
  });

  describe('listFlagged', () => {
    it('returns an empty list when nobody has an open report or is suspended', async () => {
      reports.find.mockResolvedValue([]);
      users.find.mockResolvedValue([]);

      await expect(service.listFlagged()).resolves.toEqual([]);
      // No candidate userId was ever discovered, so the profile lookup that
      // would build the flagged cards never needs to run.
      expect(profiles.find).not.toHaveBeenCalled();
    });

    it('flags a suspended member even with no open reports, as frozen', async () => {
      reports.find.mockResolvedValue([]);
      users.find.mockResolvedValue([{ id: 'user-suspended' }]);
      profiles.find.mockResolvedValue([
        makeProfile({ userId: 'user-suspended', slug: 'kai-devon' }),
      ]);

      const [flaggedMember] = await service.listFlagged();

      expect(flaggedMember!.slug).toBe('kai-devon');
      expect(flaggedMember!.openReportCount).toBe(0);
      // Suspended with no open reports left driving it reads as frozen, per
      // the documented heuristic in the service.
      expect(flaggedMember!.moderationState).toBe('frozen');
    });

    it('discovers a member by their reports\' subjectId (slug), and surfaces the most frequent reason and latest detail', async () => {
      const flaggedProfile = makeProfile({
        userId: 'user-devon',
        slug: 'devon-rae',
      });
      // Newest first, mirroring the service's `order: { createdAt: 'DESC' }`.
      reports.find.mockResolvedValue([
        makeReport({
          id: 'report-new',
          subjectId: 'devon-rae',
          reasonCode: 'harassment',
          detail: 'Second complaint, same reason.',
          createdAt: daysAgo(1),
        }),
        makeReport({
          id: 'report-old',
          subjectId: 'devon-rae',
          reasonCode: 'harassment',
          detail: 'First complaint.',
          createdAt: daysAgo(5),
        }),
      ]);
      users.find.mockResolvedValue([]);
      profiles.find.mockResolvedValue([flaggedProfile]);

      const [flaggedMember] = await service.listFlagged();

      expect(flaggedMember!.slug).toBe('devon-rae');
      expect(flaggedMember!.openReportCount).toBe(2);
      expect(flaggedMember!.topReasonCode).toBe('harassment');
      expect(flaggedMember!.latestReportDetail).toBe(
        'Second complaint, same reason.',
      );
      // Neither suspended nor frozen — just under active review.
      expect(flaggedMember!.moderationState).toBe('under_review');
    });
  });

  describe('getMember', () => {
    it('404s on an unknown slug or id', async () => {
      profiles.findOne.mockResolvedValue(null);

      await expect(service.getMember('nobody')).rejects.toThrow(
        NotFoundException,
      );
      expect(profiles.findOne).toHaveBeenCalledWith({
        where: [{ slug: 'nobody' }],
      });
    });

    it('assembles the detail view for a known member', async () => {
      const profile = makeProfile();
      profiles.findOne.mockResolvedValue(profile);
      vouchService.getVouchCount.mockResolvedValue(5);
      vouches.find.mockResolvedValue([]);
      reports.find.mockResolvedValue([]);
      communityMembers.createQueryBuilder.mockReturnValue(
        makeQueryBuilderStub({
          getRawMany: [{ role: RosterRole.Member, name: 'Circle of Care' }],
        }),
      );

      const result = await service.getMember('ines-martins');

      expect(result.slug).toBe('ines-martins');
      expect(result.vouchCount).toBe(5);
      expect(result.communities).toEqual([
        { name: 'Circle of Care', role: 'member' },
      ]);
      // No open reports and a verified profile both synthesize a "good"
      // timeline entry.
      expect(
        result.moderationTimeline.some((entry) => entry.action === 'verified'),
      ).toBe(true);
      expect(
        result.moderationTimeline.some((entry) => entry.action === 'no_reports'),
      ).toBe(true);
    });
  });
});
